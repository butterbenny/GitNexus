import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runPipelineFromRepo } from '../dist/core/ingestion/pipeline.js';
import { generateAllCSVs } from '../dist/core/kuzu/csv-generator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fixtureRepoPath = path.resolve(__dirname, '../../gitnexus-test-setup/fixture-laravel');

const getNodes = (graph, label, filePath) => {
  return graph.nodes.filter(n => {
    if (label && n.label !== label) return false;
    if (filePath && n.properties?.filePath !== filePath) return false;
    return true;
  });
};

const getRelationships = (graph, type, sourceId) => {
  return graph.relationships.filter(r => {
    if (type && r.type !== type) return false;
    if (sourceId && r.sourceId !== sourceId) return false;
    return true;
  });
};

test('PHP: indexes classes and methods', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const controllerClasses = getNodes(graph, 'Class', 'app/Http/Controllers/UserController.php')
    .filter(n => n.properties?.name === 'UserController');
  assert.equal(controllerClasses.length, 1);

  const controllerMethods = getNodes(graph, 'Method', 'app/Http/Controllers/UserController.php')
    .filter(n => n.properties?.name === 'index');
  assert.equal(controllerMethods.length, 1);

  const controllerMemberEdges = graph.relationships.filter(r => {
    return r.type === 'MEMBER_OF'
      && r.sourceId === controllerMethods[0].id
      && r.targetId === controllerClasses[0].id;
  });
  assert.equal(controllerMemberEdges.length, 1);
  assert.equal(controllerMemberEdges[0].reason, 'php-enclosing-type');
  assert.equal(controllerMemberEdges[0].confidence, 1.0);

  const serviceClasses = getNodes(graph, 'Class', 'app/Services/TicketService.php')
    .filter(n => n.properties?.name === 'TicketService');
  assert.equal(serviceClasses.length, 1);

  const serviceMethods = getNodes(graph, 'Method', 'app/Services/TicketService.php');
  assert.ok(serviceMethods.some(n => n.properties?.name === 'handle'));
  assert.ok(serviceMethods.some(n => n.properties?.name === 'format'));

  const bladeSymbols = graph.nodes.filter(n => {
    if (String(n.properties?.filePath || '').endsWith('.blade.php') === false) return false;
    return n.label !== 'File' && n.label !== 'Template';
  });
  assert.equal(bladeSymbols.length, 0);
});

test('PHP: captures extends and implements heritage edges', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const ticketService = getNodes(graph, 'Class', 'app/Services/TicketService.php')
    .find(n => n.properties?.name === 'TicketService');
  assert.ok(ticketService);

  const baseService = getNodes(graph, 'Class', 'app/Services/BaseService.php')
    .find(n => n.properties?.name === 'BaseService');
  assert.ok(baseService);

  const ticketHandler = getNodes(graph, 'Interface', 'app/Services/Contracts/TicketHandler.php')
    .find(n => n.properties?.name === 'TicketHandler');
  assert.ok(ticketHandler);

  const extendsEdges = graph.relationships.filter(r => {
    return r.type === 'EXTENDS'
      && r.sourceId === ticketService.id
      && r.targetId === baseService.id;
  });
  assert.equal(extendsEdges.length, 1);
  assert.equal(extendsEdges[0].confidence, 1.0);
  assert.equal(extendsEdges[0].reason, '');

  const implementsEdges = graph.relationships.filter(r => {
    return r.type === 'IMPLEMENTS'
      && r.sourceId === ticketService.id
      && r.targetId === ticketHandler.id;
  });
  assert.equal(implementsEdges.length, 1);
  assert.equal(implementsEdges[0].confidence, 1.0);
  assert.equal(implementsEdges[0].reason, '');
});

test('PHP: resolves member calls using inferred $this property types', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const controllerIndex = getNodes(graph, 'Method', 'app/Http/Controllers/UserController.php')
    .find(n => n.properties?.name === 'index');
  assert.ok(controllerIndex);

  const serviceHandle = getNodes(graph, 'Method', 'app/Services/TicketService.php')
    .find(n => n.properties?.name === 'handle');
  assert.ok(serviceHandle);

  const serviceUpdate = getNodes(graph, 'Method', 'app/Services/TicketService.php')
    .find(n => n.properties?.name === 'update');
  assert.ok(serviceUpdate);

  const callEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerIndex.id
      && r.targetId === serviceHandle.id;
  });
  assert.equal(callEdges.length, 1);
  assert.equal(callEdges[0].reason, 'import-resolved');
  assert.ok(callEdges[0].confidence >= 0.9);

  const updateEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerIndex.id
      && r.targetId === serviceUpdate.id;
  });
  assert.equal(updateEdges.length, 1);
  assert.equal(updateEdges[0].reason, 'import-resolved');
  assert.ok(updateEdges[0].confidence >= 0.9);
});

test('PHP: infers container-resolved property types via app()', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const controllerIndex = getNodes(graph, 'Method', 'app/Http/Controllers/UserController.php')
    .find(n => n.properties?.name === 'index');
  assert.ok(controllerIndex);

  const emailServiceSend = getNodes(graph, 'Method', 'app/Services/EmailService.php')
    .find(n => n.properties?.name === 'send');
  assert.ok(emailServiceSend);

  const callEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerIndex.id
      && r.targetId === emailServiceSend.id;
  });
  assert.equal(callEdges.length, 1);
  assert.equal(callEdges[0].reason, 'import-resolved');
  assert.ok(callEdges[0].confidence >= 0.9);
});

test('PHP: resolves inline receivers (app/resolve/new) for member calls', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const controllerIndex = getNodes(graph, 'Method', 'app/Http/Controllers/UserController.php')
    .find(n => n.properties?.name === 'index');
  assert.ok(controllerIndex);

  const emailSendViaApp = getNodes(graph, 'Method', 'app/Services/EmailService.php')
    .find(n => n.properties?.name === 'sendViaApp');
  assert.ok(emailSendViaApp);

  const emailSendViaResolve = getNodes(graph, 'Method', 'app/Services/EmailService.php')
    .find(n => n.properties?.name === 'sendViaResolve');
  assert.ok(emailSendViaResolve);

  const ticketHandleViaNew = getNodes(graph, 'Method', 'app/Services/TicketService.php')
    .find(n => n.properties?.name === 'handleViaNew');
  assert.ok(ticketHandleViaNew);

  const assertCallEdge = (target) => {
    const edges = graph.relationships.filter(r => {
      return r.type === 'CALLS'
        && r.sourceId === controllerIndex.id
        && r.targetId === target.id;
    });
    assert.equal(edges.length, 1);
    assert.equal(edges[0].reason, 'import-resolved');
    assert.ok(edges[0].confidence >= 0.9);
  };

  assertCallEdge(emailSendViaApp);
  assertCallEdge(emailSendViaResolve);
  assertCallEdge(ticketHandleViaNew);
});

test('PHP: resolves container make receivers (app()->make / App::make) for member calls', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const controllerIndex = getNodes(graph, 'Method', 'app/Http/Controllers/UserController.php')
    .find(n => n.properties?.name === 'index');
  assert.ok(controllerIndex);

  const emailSendViaMake = getNodes(graph, 'Method', 'app/Services/EmailService.php')
    .find(n => n.properties?.name === 'sendViaMake');
  assert.ok(emailSendViaMake);

  const emailSendViaFacadeMake = getNodes(graph, 'Method', 'app/Services/EmailService.php')
    .find(n => n.properties?.name === 'sendViaFacadeMake');
  assert.ok(emailSendViaFacadeMake);

  const emailSendViaMakeAssigned = getNodes(graph, 'Method', 'app/Services/EmailService.php')
    .find(n => n.properties?.name === 'sendViaMakeAssigned');
  assert.ok(emailSendViaMakeAssigned);

  const emailSendViaFacadeMakeAssigned = getNodes(graph, 'Method', 'app/Services/EmailService.php')
    .find(n => n.properties?.name === 'sendViaFacadeMakeAssigned');
  assert.ok(emailSendViaFacadeMakeAssigned);

  const assertCallEdge = (target) => {
    const edges = graph.relationships.filter(r => {
      return r.type === 'CALLS'
        && r.sourceId === controllerIndex.id
        && r.targetId === target.id;
    });
    assert.equal(edges.length, 1);
    assert.equal(edges[0].reason, 'import-resolved');
    assert.ok(edges[0].confidence >= 0.9);
  };

  assertCallEdge(emailSendViaMake);
  assertCallEdge(emailSendViaFacadeMake);
  assertCallEdge(emailSendViaMakeAssigned);
  assertCallEdge(emailSendViaFacadeMakeAssigned);
});

test('PHP: resolves $this calls to trait methods', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const serviceHandle = getNodes(graph, 'Method', 'app/Services/TraitUserService.php')
    .find(n => n.properties?.name === 'handle');
  assert.ok(serviceHandle);

  const traitNode = getNodes(graph, 'Trait', 'app/Traits/DoesThing.php')
    .find(n => n.properties?.name === 'DoesThing');
  assert.ok(traitNode);

  const traitDoThing = getNodes(graph, 'Method', 'app/Traits/DoesThing.php')
    .find(n => n.properties?.name === 'doThing');
  assert.ok(traitDoThing);

  const traitMemberEdges = graph.relationships.filter(r => {
    return r.type === 'MEMBER_OF'
      && r.sourceId === traitDoThing.id
      && r.targetId === traitNode.id;
  });
  assert.equal(traitMemberEdges.length, 1);
  assert.equal(traitMemberEdges[0].reason, 'php-enclosing-type');
  assert.equal(traitMemberEdges[0].confidence, 1.0);

  const callEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === serviceHandle.id
      && r.targetId === traitDoThing.id;
  });
  assert.equal(callEdges.length, 1);
  assert.equal(callEdges[0].reason, 'import-resolved');
  assert.ok(callEdges[0].confidence >= 0.9);
});

test('Laravel semantic: controller method wires to FormRequest + Resource types', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const controllerUpdate = getNodes(graph, 'Method', 'app/Http/Controllers/UserController.php')
    .find(n => n.properties?.name === 'update');
  assert.ok(controllerUpdate);

  const requestClass = getNodes(graph, 'Class', 'app/Http/Requests/UpdateUserRequest.php')
    .find(n => n.properties?.name === 'UpdateUserRequest');
  assert.ok(requestClass);

  const resourceClass = getNodes(graph, 'Class', 'app/Http/Resources/UserResource.php')
    .find(n => n.properties?.name === 'UserResource');
  assert.ok(resourceClass);

  const formRequestEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerUpdate.id
      && r.targetId === requestClass.id;
  });
  assert.equal(formRequestEdges.length, 1);
  assert.equal(formRequestEdges[0].reason, 'laravel-form-request:param');
  assert.ok(formRequestEdges[0].confidence >= 0.9);

  const resourceEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerUpdate.id
      && r.targetId === resourceClass.id;
  });
  assert.equal(resourceEdges.length, 1);
  assert.equal(resourceEdges[0].reason, 'laravel-resource:return');
  assert.ok(resourceEdges[0].confidence >= 0.9);
});

test('Laravel auth: controller methods wire to Policy methods + Permission enums', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const controllerUpdate = getNodes(graph, 'Method', 'app/Http/Controllers/UserController.php')
    .find(n => n.properties?.name === 'update');
  assert.ok(controllerUpdate);

  const controllerCanTest = getNodes(graph, 'Method', 'app/Http/Controllers/UserController.php')
    .find(n => n.properties?.name === 'canTest');
  assert.ok(controllerCanTest);

  const policyUpdate = getNodes(graph, 'Method', 'app/Policies/UserPolicy.php')
    .find(n => n.properties?.name === 'update');
  assert.ok(policyUpdate);

  const policyManageMember = getNodes(graph, 'Method', 'app/Policies/UserPolicy.php')
    .find(n => n.properties?.name === 'manageMember');
  assert.ok(policyManageMember);

  const accountPermissionEnum = getNodes(graph, 'Enum', 'app/Domains/AccessControl/Permissions/AccountPermission.php')
    .find(n => n.properties?.name === 'AccountPermission');
  assert.ok(accountPermissionEnum);

  const accountPermissionEdit = getNodes(graph, 'Const', 'app/Domains/AccessControl/Permissions/AccountPermission.php')
    .find(n => n.properties?.name === 'EDIT');
  assert.ok(accountPermissionEdit);

  const policyEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerUpdate.id
      && r.targetId === policyUpdate.id
      && r.reason === 'laravel-authorize:update';
  });
  assert.equal(policyEdges.length, 1);
  assert.ok(policyEdges[0].confidence >= 0.9);

  const permissionEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerUpdate.id
      && r.targetId === accountPermissionEdit.id
      && r.reason === 'laravel-authorize:AccountPermission::EDIT';
  });
  assert.equal(permissionEdges.length, 1);
  assert.ok(permissionEdges[0].confidence >= 0.9);

  const manageMemberEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerUpdate.id
      && r.targetId === policyManageMember.id
      && r.reason === 'laravel-authorize:manage-member';
  });
  assert.equal(manageMemberEdges.length, 1);
  assert.ok(manageMemberEdges[0].confidence >= 0.9);

  const canPolicyEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerCanTest.id
      && r.targetId === policyUpdate.id
      && r.reason === 'laravel-can:update';
  });
  assert.equal(canPolicyEdges.length, 1);
  assert.ok(canPolicyEdges[0].confidence >= 0.9);

  const canPermissionEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerCanTest.id
      && r.targetId === accountPermissionEdit.id
      && r.reason === 'laravel-can:AccountPermission::EDIT';
  });
  assert.equal(canPermissionEdges.length, 1);
  assert.ok(canPermissionEdges[0].confidence >= 0.9);

  const canManageMemberEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerCanTest.id
      && r.targetId === policyManageMember.id
      && r.reason === 'laravel-can:manage-member';
  });
  assert.equal(canManageMemberEdges.length, 1);
  assert.ok(canManageMemberEdges[0].confidence >= 0.9);
});

test('Laravel permissions config: wires roles to permission enum cases', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const financeRole = getNodes(graph, 'CodeElement', 'config/permissions.php')
    .find(n => n.properties?.name === 'role:finance');
  assert.ok(financeRole);

  const adminRole = getNodes(graph, 'CodeElement', 'config/permissions.php')
    .find(n => n.properties?.name === 'role:administrator');
  assert.ok(adminRole);

  const editorRole = getNodes(graph, 'CodeElement', 'config/permissions.php')
    .find(n => n.properties?.name === 'role:editor');
  assert.ok(editorRole);

  const accountView = getNodes(graph, 'Const', 'app/Domains/AccessControl/Permissions/AccountPermission.php')
    .find(n => n.properties?.name === 'VIEW');
  assert.ok(accountView);

  const accountEdit = getNodes(graph, 'Const', 'app/Domains/AccessControl/Permissions/AccountPermission.php')
    .find(n => n.properties?.name === 'EDIT');
  assert.ok(accountEdit);

  const accountViewSlug = getNodes(graph, 'CodeElement', 'app/Domains/AccessControl/Permissions/AccountPermission.php')
    .find(n => n.properties?.name === 'account.view');
  assert.ok(accountViewSlug);

  const accountEditSlug = getNodes(graph, 'CodeElement', 'app/Domains/AccessControl/Permissions/AccountPermission.php')
    .find(n => n.properties?.name === 'account.edit');
  assert.ok(accountEditSlug);

  const assertRolePermissionEdge = (source, target, reason) => {
    const edges = graph.relationships.filter(r => {
      return r.type === 'CALLS'
        && r.sourceId === source.id
        && r.targetId === target.id
        && r.reason === reason;
    });
    assert.equal(edges.length, 1);
    assert.ok(edges[0].confidence >= 0.9);
  };

  assertRolePermissionEdge(financeRole, accountView, 'laravel-role-permission:AccountPermission::VIEW');
  assertRolePermissionEdge(financeRole, accountEdit, 'laravel-role-permission:AccountPermission::EDIT');
  assertRolePermissionEdge(financeRole, accountViewSlug, 'laravel-role-permission-slug:account.view');
  assertRolePermissionEdge(financeRole, accountEditSlug, 'laravel-role-permission-slug:account.edit');

  // AccountPermission::ALL expands to VIEW + EDIT
  assertRolePermissionEdge(adminRole, accountView, 'laravel-role-permission:AccountPermission::VIEW');
  assertRolePermissionEdge(adminRole, accountEdit, 'laravel-role-permission:AccountPermission::EDIT');
  assertRolePermissionEdge(adminRole, accountViewSlug, 'laravel-role-permission-slug:account.view');
  assertRolePermissionEdge(adminRole, accountEditSlug, 'laravel-role-permission-slug:account.edit');

  // ...AccountPermission::allExcept([EDIT]) yields VIEW only
  assertRolePermissionEdge(editorRole, accountView, 'laravel-role-permission:AccountPermission::VIEW');
  assertRolePermissionEdge(editorRole, accountViewSlug, 'laravel-role-permission-slug:account.view');
  const editorEditEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === editorRole.id
      && r.targetId === accountEdit.id;
  });
  assert.equal(editorEditEdges.length, 0);

  const editorEditSlugEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === editorRole.id
      && r.targetId === accountEditSlug.id;
  });
  assert.equal(editorEditSlugEdges.length, 0);

  const enumSlugEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === accountView.id
      && r.targetId === accountViewSlug.id
      && r.reason === 'laravel-permission-slug:account.view';
  });
  assert.equal(enumSlugEdges.length, 1);
  assert.equal(enumSlugEdges[0].confidence, 1.0);
});

test('PHP: match return expressions wire to enum cases', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const permissionFor = getNodes(graph, 'Method', 'app/Services/TicketService.php')
    .find(n => n.properties?.name === 'permissionFor');
  assert.ok(permissionFor);

  const accountView = getNodes(graph, 'Const', 'app/Domains/AccessControl/Permissions/AccountPermission.php')
    .find(n => n.properties?.name === 'VIEW');
  assert.ok(accountView);

  const accountEdit = getNodes(graph, 'Const', 'app/Domains/AccessControl/Permissions/AccountPermission.php')
    .find(n => n.properties?.name === 'EDIT');
  assert.ok(accountEdit);

  const viewEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === permissionFor.id
      && r.targetId === accountView.id
      && r.reason === 'php-match-return:AccountPermission::VIEW';
  });
  assert.equal(viewEdges.length, 1);
  assert.ok(viewEdges[0].confidence >= 0.9);

  const editEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === permissionFor.id
      && r.targetId === accountEdit.id
      && r.reason === 'php-match-return:AccountPermission::EDIT';
  });
  assert.equal(editEdges.length, 1);
  assert.ok(editEdges[0].confidence >= 0.9);
});

test('Laravel Eloquent: relationship methods wire to related model classes', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const campaignMembers = getNodes(graph, 'Method', 'app/Models/Campaign/Campaign.php')
    .find(n => n.properties?.name === 'members');
  assert.ok(campaignMembers);

  const campaignMembersWithScope = getNodes(graph, 'Method', 'app/Models/Campaign/Campaign.php')
    .find(n => n.properties?.name === 'membersWithScope');
  assert.ok(campaignMembersWithScope);

  const campaignOwner = getNodes(graph, 'Method', 'app/Models/Campaign/Campaign.php')
    .find(n => n.properties?.name === 'owner');
  assert.ok(campaignOwner);

  const campaignItems = getNodes(graph, 'Method', 'app/Models/Campaign/Campaign.php')
    .find(n => n.properties?.name === 'items');
  assert.ok(campaignItems);

  const campaignMemberClass = getNodes(graph, 'Class', 'app/Models/Campaign/CampaignMember.php')
    .find(n => n.properties?.name === 'CampaignMember');
  assert.ok(campaignMemberClass);

  const userClass = getNodes(graph, 'Class', 'app/Models/User.php')
    .find(n => n.properties?.name === 'User');
  assert.ok(userClass);

  const campaignItemClass = getNodes(graph, 'Class', 'app/Models/Campaign/CampaignItem.php')
    .find(n => n.properties?.name === 'CampaignItem');
  assert.ok(campaignItemClass);

  const campaignItemPivotClass = getNodes(graph, 'Class', 'app/Models/Campaign/CampaignItemPivot.php')
    .find(n => n.properties?.name === 'CampaignItemPivot');
  assert.ok(campaignItemPivotClass);

  const assertEloquentEdge = (source, target, reason) => {
    const edges = graph.relationships.filter(r => {
      return r.type === 'CALLS'
        && r.sourceId === source.id
        && r.targetId === target.id
        && r.reason === reason;
    });
    assert.equal(edges.length, 1);
    assert.ok(edges[0].confidence >= 0.9);
  };

  assertEloquentEdge(campaignMembers, campaignMemberClass, 'laravel-eloquent:hasMany');
  assertEloquentEdge(campaignMembersWithScope, campaignMemberClass, 'laravel-eloquent:hasMany');
  assertEloquentEdge(campaignOwner, userClass, 'laravel-eloquent:belongsTo');
  assertEloquentEdge(campaignItems, campaignItemClass, 'laravel-eloquent:hasManyThrough');
  assertEloquentEdge(campaignItems, campaignItemPivotClass, 'laravel-eloquent:hasManyThrough:through');
});

test('Laravel Eloquent: with/load strings wire to relationship methods', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const controllerIndex = getNodes(graph, 'Method', 'app/Http/Controllers/UserController.php')
    .find(n => n.properties?.name === 'index');
  assert.ok(controllerIndex);

  const campaignMembers = getNodes(graph, 'Method', 'app/Models/Campaign/Campaign.php')
    .find(n => n.properties?.name === 'members');
  assert.ok(campaignMembers);

  const campaignMemberUser = getNodes(graph, 'Method', 'app/Models/Campaign/CampaignMember.php')
    .find(n => n.properties?.name === 'user');
  assert.ok(campaignMemberUser);

  const membersEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerIndex.id
      && r.targetId === campaignMembers.id
      && r.reason === 'laravel-eloquent-load:with:members';
  });
  assert.equal(membersEdges.length, 1);
  assert.ok(membersEdges[0].confidence >= 0.9);

  const nestedEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerIndex.id
      && r.targetId === campaignMemberUser.id
      && r.reason === 'laravel-eloquent-load:with:members.user';
  });
  assert.equal(nestedEdges.length, 1);
  assert.ok(nestedEdges[0].confidence >= 0.9);
});

test('Laravel resources: whenLoaded wires to relationship methods (contract edges)', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const campaignResource = getNodes(graph, 'Class', 'app/Http/Resources/CampaignResource.php')
    .find(n => n.properties?.name === 'CampaignResource');
  assert.ok(campaignResource);

  const campaignMembers = getNodes(graph, 'Method', 'app/Models/Campaign/Campaign.php')
    .find(n => n.properties?.name === 'members');
  assert.ok(campaignMembers);

  const campaignMemberUser = getNodes(graph, 'Method', 'app/Models/Campaign/CampaignMember.php')
    .find(n => n.properties?.name === 'user');
  assert.ok(campaignMemberUser);

  const membersEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === campaignResource.id
      && r.targetId === campaignMembers.id
      && r.reason === 'laravel-resource-requires:members';
  });
  assert.equal(membersEdges.length, 1);
  assert.ok(membersEdges[0].confidence >= 0.9);

  const nestedEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === campaignResource.id
      && r.targetId === campaignMemberUser.id
      && r.reason === 'laravel-resource-requires:members.user';
  });
  assert.equal(nestedEdges.length, 1);
  assert.ok(nestedEdges[0].confidence >= 0.9);
});

test('PHP: resolves imports from use statements', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const routeFileId = getNodes(graph, 'File', 'routes/web.php')[0]?.id;
  assert.ok(routeFileId);

  const routeImports = getRelationships(graph, 'IMPORTS', routeFileId);
  const importedPaths = new Set(
    routeImports
      .map(r => graph.nodes.find(n => n.id === r.targetId))
      .filter(Boolean)
      .map(n => n.properties.filePath)
  );

  assert.ok(importedPaths.has('app/Http/Controllers/UserController.php'));

  const controllerFileId = getNodes(graph, 'File', 'app/Http/Controllers/UserController.php')[0]?.id;
  assert.ok(controllerFileId);

  const controllerImports = getRelationships(graph, 'IMPORTS', controllerFileId);
  const controllerImportedPaths = new Set(
    controllerImports
      .map(r => graph.nodes.find(n => n.id === r.targetId))
      .filter(Boolean)
      .map(n => n.properties.filePath)
  );
  assert.ok(controllerImportedPaths.has('app/Services/TicketService.php'));
  assert.ok(controllerImportedPaths.has('app/Services/EmailService.php'));
  assert.ok(controllerImportedPaths.has('lib/Utils/Str.php'));

  const pkgConsumerFileId = getNodes(graph, 'File', 'packages/acme/src/Consumer.php')[0]?.id;
  assert.ok(pkgConsumerFileId);

  const pkgConsumerImports = getRelationships(graph, 'IMPORTS', pkgConsumerFileId);
  const pkgConsumerImportedPaths = new Set(
    pkgConsumerImports
      .map(r => graph.nodes.find(n => n.id === r.targetId))
      .filter(Boolean)
      .map(n => n.properties.filePath)
  );
  assert.ok(pkgConsumerImportedPaths.has('packages/acme/src/Utils/Helper.php'));
  assert.ok(!pkgConsumerImportedPaths.has('lib/Utils/Helper.php'));
});

test('PHP Laravel: routes wire to controller methods', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const routeFile = getNodes(graph, 'File', 'routes/web.php')[0];
  assert.ok(routeFile);

  const controllerMethod = getNodes(graph, 'Method', 'app/Http/Controllers/UserController.php')
    .find(n => n.properties?.name === 'index');
  assert.ok(controllerMethod);

  const routeCalls = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === routeFile.id && r.targetId === controllerMethod.id;
  });
  assert.equal(routeCalls.length, 1);
  assert.equal(routeCalls[0].reason, 'laravel-route-import-resolved');
  assert.ok(routeCalls[0].confidence >= 0.9);
});

test('Laravel: route-name usage wires to controller methods', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const controllerIndex = getNodes(graph, 'Method', 'app/Http/Controllers/UserController.php')
    .find(n => n.properties?.name === 'index');
  assert.ok(controllerIndex);

  const usersTemplate = getNodes(graph, 'Template', 'resources/views/users/index.blade.php')[0];
  assert.ok(usersTemplate);

  const templateRouteEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === usersTemplate.id
      && r.targetId === controllerIndex.id
      && String(r.reason || '').startsWith('route-name:users.index');
  });
  assert.equal(templateRouteEdges.length, 1);
  assert.ok(templateRouteEdges[0].confidence >= 0.9);

  const usersIndexUrl = getNodes(graph, 'Function', 'frontend/api.ts')
    .find(n => n.properties?.name === 'usersIndexUrl');
  assert.ok(usersIndexUrl);

  const tsRouteEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === usersIndexUrl.id
      && r.targetId === controllerIndex.id
      && String(r.reason || '').startsWith('route-name:users.index');
  });
  assert.equal(tsRouteEdges.length, 1);
  assert.ok(tsRouteEdges[0].confidence >= 0.9);

  const phpRouteHelper = getNodes(graph, 'Method', 'app/Services/EmailService.php')
    .find(n => n.properties?.name === 'usersIndexUrl');
  assert.ok(phpRouteHelper);

  const phpRouteEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === phpRouteHelper.id
      && r.targetId === controllerIndex.id
      && String(r.reason || '').startsWith('route-name:users.index');
  });
  assert.equal(phpRouteEdges.length, 1);
  assert.ok(phpRouteEdges[0].confidence >= 0.9);
});

test('PHP Laravel: events wire to listener and subscriber methods', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const eventProviderFile = getNodes(graph, 'File', 'app/Providers/EventServiceProvider.php')[0];
  assert.ok(eventProviderFile);

  const listenerHandle = getNodes(graph, 'Method', 'app/Listeners/SendWelcomeEmail.php')
    .find(n => n.properties?.name === 'handle');
  assert.ok(listenerHandle);

  const controllerIndex = getNodes(graph, 'Method', 'app/Http/Controllers/UserController.php')
    .find(n => n.properties?.name === 'index');
  assert.ok(controllerIndex);

  const subscriberSubscribe = getNodes(graph, 'Method', 'app/Listeners/UserEventSubscriber.php')
    .find(n => n.properties?.name === 'subscribe');
  assert.ok(subscriberSubscribe);

  const listenEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === eventProviderFile.id && r.targetId === listenerHandle.id;
  });
  assert.equal(listenEdges.length, 0);

  const subscribeEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === eventProviderFile.id && r.targetId === subscriberSubscribe.id;
  });
  assert.equal(subscribeEdges.length, 1);
  assert.equal(subscribeEdges[0].reason, 'laravel-event-subscribe-import-resolved');
  assert.ok(subscribeEdges[0].confidence >= 0.9);

  const subscriberHandler = getNodes(graph, 'Method', 'app/Listeners/UserEventSubscriber.php')
    .find(n => n.properties?.name === 'onUserRegistered');
  assert.ok(subscriberHandler);

  const dispatchReasons = [
    'laravel-event-dispatch-helper-import-resolved',
    'laravel-event-dispatch-facade-import-resolved',
    'laravel-event-dispatch-static-import-resolved',
  ];

  for (const expectedReason of dispatchReasons) {
    const dispatchEdges = graph.relationships.filter(r => {
      return r.type === 'CALLS'
        && r.sourceId === controllerIndex.id
        && r.targetId === listenerHandle.id
        && r.reason === expectedReason;
    });
    assert.equal(dispatchEdges.length, 1);
    assert.ok(dispatchEdges[0].confidence >= 0.8);

    const subscriberEdges = graph.relationships.filter(r => {
      return r.type === 'CALLS'
        && r.sourceId === controllerIndex.id
        && r.targetId === subscriberHandler.id
        && r.reason === expectedReason;
    });
    assert.equal(subscriberEdges.length, 1);
    assert.ok(subscriberEdges[0].confidence >= 0.9);
  }
});

test('PHP Laravel: scheduler wires to job and command handlers', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const kernelFile = getNodes(graph, 'File', 'app/Console/Kernel.php')[0];
  assert.ok(kernelFile);

  const sendDigestHandle = getNodes(graph, 'Method', 'app/Jobs/SendDigestJob.php')
    .find(n => n.properties?.name === 'handle');
  assert.ok(sendDigestHandle);

  const cleanupHandle = getNodes(graph, 'Method', 'app/Jobs/CleanupJob.php')
    .find(n => n.properties?.name === 'handle');
  assert.ok(cleanupHandle);

  const commandHandle = getNodes(graph, 'Method', 'app/Console/Commands/SendDigestCommand.php')
    .find(n => n.properties?.name === 'handle');
  assert.ok(commandHandle);

  const sendDigestEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === kernelFile.id && r.targetId === sendDigestHandle.id;
  });
  assert.equal(sendDigestEdges.length, 1);
  assert.equal(sendDigestEdges[0].reason, 'laravel-schedule-job-import-resolved');
  assert.ok(sendDigestEdges[0].confidence >= 0.9);

  const cleanupEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === kernelFile.id && r.targetId === cleanupHandle.id;
  });
  assert.equal(cleanupEdges.length, 1);
  assert.equal(cleanupEdges[0].reason, 'laravel-schedule-job-import-resolved');
  assert.ok(cleanupEdges[0].confidence >= 0.9);

  const commandEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === kernelFile.id && r.targetId === commandHandle.id;
  });
  assert.equal(commandEdges.length, 1);
  assert.equal(commandEdges[0].reason, 'laravel-schedule-command-import-resolved');
  assert.ok(commandEdges[0].confidence >= 0.9);
});

test('PHP Laravel: job dispatch wires to job handlers', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const controllerIndex = getNodes(graph, 'Method', 'app/Http/Controllers/UserController.php')
    .find(n => n.properties?.name === 'index');
  assert.ok(controllerIndex);

  const sendDigestHandle = getNodes(graph, 'Method', 'app/Jobs/SendDigestJob.php')
    .find(n => n.properties?.name === 'handle');
  assert.ok(sendDigestHandle);

  const cleanupHandle = getNodes(graph, 'Method', 'app/Jobs/CleanupJob.php')
    .find(n => n.properties?.name === 'handle');
  assert.ok(cleanupHandle);

  const staticDispatchEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerIndex.id
      && r.targetId === sendDigestHandle.id
      && r.reason === 'laravel-job-dispatch-static-import-resolved';
  });
  assert.equal(staticDispatchEdges.length, 1);
  assert.ok(staticDispatchEdges[0].confidence >= 0.9);

  const helperDispatchEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerIndex.id
      && r.targetId === cleanupHandle.id
      && r.reason === 'laravel-job-dispatch-helper-import-resolved';
  });
  assert.equal(helperDispatchEdges.length, 1);
  assert.ok(helperDispatchEdges[0].confidence >= 0.9);

  const helperSyncDispatchEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerIndex.id
      && r.targetId === cleanupHandle.id
      && r.reason === 'laravel-job-dispatch-helper-sync-import-resolved';
  });
  assert.equal(helperSyncDispatchEdges.length, 1);
  assert.ok(helperSyncDispatchEdges[0].confidence >= 0.9);
});

test('PHP: call edges resolve within-file and via imports', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const controllerIndex = getNodes(graph, 'Method', 'app/Http/Controllers/UserController.php')
    .find(n => n.properties?.name === 'index');
  assert.ok(controllerIndex);

  const ticketHandle = getNodes(graph, 'Method', 'app/Services/TicketService.php')
    .find(n => n.properties?.name === 'handle');
  assert.ok(ticketHandle);

  const ticketFormat = getNodes(graph, 'Method', 'app/Services/TicketService.php')
    .find(n => n.properties?.name === 'format');
  assert.ok(ticketFormat);

  const strUpper = getNodes(graph, 'Method', 'lib/Utils/Str.php')
    .find(n => n.properties?.name === 'upper');
  assert.ok(strUpper);

  const indexCallsHandle = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === controllerIndex.id && r.targetId === ticketHandle.id;
  });
  assert.equal(indexCallsHandle.length, 1);
  assert.equal(indexCallsHandle[0].reason, 'import-resolved');
  assert.ok(indexCallsHandle[0].confidence >= 0.9);

  const indexCallsUpper = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === controllerIndex.id && r.targetId === strUpper.id;
  });
  assert.equal(indexCallsUpper.length, 1);
  assert.equal(indexCallsUpper[0].reason, 'import-resolved');
  assert.ok(indexCallsUpper[0].confidence >= 0.9);

  const handleCallsFormat = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === ticketHandle.id && r.targetId === ticketFormat.id;
  });
  assert.equal(handleCallsFormat.length, 1);
  assert.equal(handleCallsFormat[0].reason, 'same-file');
  assert.ok(handleCallsFormat[0].confidence >= 0.85);
});

test('Blade: indexes templates and template relationships', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const welcome = getNodes(graph, 'Template', 'resources/views/emails/welcome.blade.php')[0];
  assert.ok(welcome);
  assert.equal(welcome.properties?.name, 'emails.welcome');

  const layout = getNodes(graph, 'Template', 'resources/views/layouts/app.blade.php')[0];
  assert.ok(layout);
  assert.equal(layout.properties?.name, 'layouts.app');

  const footer = getNodes(graph, 'Template', 'resources/views/emails/partials/footer.blade.php')[0];
  assert.ok(footer);
  assert.equal(footer.properties?.name, 'emails.partials.footer');

  const button = getNodes(graph, 'Template', 'resources/views/components/button.blade.php')[0];
  assert.ok(button);
  assert.equal(button.properties?.name, 'components.button');

  const extendsRels = graph.relationships.filter(r => {
    return r.type === 'EXTENDS' && r.sourceId === welcome.id && r.targetId === layout.id;
  });
  assert.equal(extendsRels.length, 1);
  assert.equal(extendsRels[0].reason, 'blade-extends');
  assert.equal(extendsRels[0].confidence, 1.0);

  const importRels = graph.relationships.filter(r => {
    return r.type === 'IMPORTS' && r.sourceId === welcome.id;
  });
  const importedIds = new Set(importRels.map(r => r.targetId));
  assert.ok(importedIds.has(footer.id));
  assert.ok(importedIds.has(button.id));
});

test('Blade: @vite wires templates to asset files', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const layout = getNodes(graph, 'Template', 'resources/views/layouts/app.blade.php')[0];
  assert.ok(layout);

  const appAsset = getNodes(graph, 'File', 'resources/js/app.ts')[0];
  assert.ok(appAsset);

  const layoutViteEdges = graph.relationships.filter(r => {
    return r.type === 'IMPORTS'
      && r.sourceId === layout.id
      && r.targetId === appAsset.id
      && r.reason === 'blade-vite';
  });
  assert.equal(layoutViteEdges.length, 1);
  assert.equal(layoutViteEdges[0].confidence, 1.0);

  const nested = getNodes(graph, 'Template', 'apps/backend/resources/views/emails/nested.blade.php')[0];
  assert.ok(nested);

  const nestedAsset = getNodes(graph, 'File', 'apps/backend/resources/js/nested.ts')[0];
  assert.ok(nestedAsset);

  const nestedViteEdges = graph.relationships.filter(r => {
    return r.type === 'IMPORTS'
      && r.sourceId === nested.id
      && r.targetId === nestedAsset.id
      && r.reason === 'blade-vite';
  });
  assert.equal(nestedViteEdges.length, 1);
  assert.equal(nestedViteEdges[0].confidence, 1.0);
});

test('Laravel: view and mail wire to Blade templates', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const welcome = getNodes(graph, 'Template', 'resources/views/emails/welcome.blade.php')[0];
  assert.ok(welcome);

  const controllerIndex = getNodes(graph, 'Method', 'app/Http/Controllers/UserController.php')
    .find(n => n.properties?.name === 'index');
  assert.ok(controllerIndex);

  const mailableBuild = getNodes(graph, 'Method', 'app/Mail/WelcomeMail.php')
    .find(n => n.properties?.name === 'build');
  assert.ok(mailableBuild);

  const controllerViewEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === controllerIndex.id && r.targetId === welcome.id && r.reason === 'laravel-view';
  });
  assert.equal(controllerViewEdges.length, 1);
  assert.equal(controllerViewEdges[0].confidence, 1.0);

  const mailableViewEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === mailableBuild.id && r.targetId === welcome.id && r.reason === 'laravel-mailable-view';
  });
  assert.equal(mailableViewEdges.length, 1);

  const mailSendEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === controllerIndex.id && r.targetId === welcome.id && String(r.reason || '').startsWith('laravel-mail-send-mailable:');
  });
  assert.equal(mailSendEdges.length, 1);
  assert.ok(mailSendEdges[0].confidence >= 0.8);
});

test('Laravel: view wiring resolves Blade templates under nested app roots', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const nested = getNodes(graph, 'Template', 'apps/backend/resources/views/emails/nested.blade.php')[0];
  assert.ok(nested);
  assert.equal(nested.properties?.name, 'emails.nested');

  const nestedIndex = getNodes(graph, 'Method', 'apps/backend/app/Http/Controllers/NestedController.php')
    .find(n => n.properties?.name === 'index');
  assert.ok(nestedIndex);

  const nestedViewEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === nestedIndex.id && r.targetId === nested.id && r.reason === 'laravel-view';
  });
  assert.equal(nestedViewEdges.length, 1);
  assert.equal(nestedViewEdges[0].confidence, 1.0);
});

test('Kuzu CSV: generates Template table rows', async () => {
  const { graph, fileContents } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const csvData = generateAllCSVs(graph, fileContents);
  const templateCSV = csvData.nodes.get('Template');
  assert.ok(templateCSV);
  assert.ok(templateCSV.startsWith('id,name,filePath,startLine,endLine,content'));
  assert.ok(templateCSV.includes('resources/views/emails/welcome.blade.php'));
});

test('Svelte: TypeScript imports resolve to .svelte files', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const mainFileId = getNodes(graph, 'File', 'frontend/main.ts')[0]?.id;
  assert.ok(mainFileId);

  const imports = getRelationships(graph, 'IMPORTS', mainFileId);
  const importedPaths = new Set(
    imports
      .map(r => graph.nodes.find(n => n.id === r.targetId))
      .filter(Boolean)
      .map(n => n.properties.filePath)
  );

  assert.ok(importedPaths.has('frontend/components/Button.svelte'));
});

test('Svelte: indexes <script> symbols and resolves calls via imports', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const svelteFile = getNodes(graph, 'File', 'frontend/components/Button.svelte')[0];
  assert.ok(svelteFile);

  const utilsFile = getNodes(graph, 'File', 'frontend/utils.ts')[0];
  assert.ok(utilsFile);

  const buttonLabelFn = getNodes(graph, 'Function', 'frontend/components/Button.svelte')
    .find(n => n.properties?.name === 'getButtonLabel');
  assert.ok(buttonLabelFn);

  const formatLabelFn = getNodes(graph, 'Function', 'frontend/utils.ts')
    .find(n => n.properties?.name === 'formatLabel');
  assert.ok(formatLabelFn);

  const svelteImports = graph.relationships.filter(r => {
    return r.type === 'IMPORTS' && r.sourceId === svelteFile.id && r.targetId === utilsFile.id;
  });
  assert.equal(svelteImports.length, 1);

  const calls = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === buttonLabelFn.id && r.targetId === formatLabelFn.id;
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reason, 'import-resolved');
  assert.ok(calls[0].confidence >= 0.9);
});

test('Full-stack: frontend HTTP calls wire to Laravel controller methods', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const fetchUsers = getNodes(graph, 'Function', 'frontend/api.ts')
    .find(n => n.properties?.name === 'fetchUsers');
  assert.ok(fetchUsers);

  const controllerIndex = getNodes(graph, 'Method', 'app/Http/Controllers/UserController.php')
    .find(n => n.properties?.name === 'index');
  assert.ok(controllerIndex);

  const endpointGetUsers = getNodes(graph, 'CodeElement', 'routes/api.php')
    .find(n => n.properties?.name === 'endpoint:get:/api/users');
  assert.ok(endpointGetUsers);

  const httpEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === fetchUsers.id
      && r.targetId === controllerIndex.id
      && r.reason === 'http-get:/api/users';
  });
  assert.equal(httpEdges.length, 1);
  assert.ok(httpEdges[0].confidence >= 0.9);

  const feToEndpointEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === fetchUsers.id
      && r.targetId === endpointGetUsers.id
      && r.reason === 'http-get:/api/users';
  });
  assert.equal(feToEndpointEdges.length, 1);
  assert.ok(feToEndpointEdges[0].confidence >= 0.9);

  const endpointToControllerEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === endpointGetUsers.id
      && r.targetId === controllerIndex.id
      && String(r.reason || '').startsWith('laravel-endpoint:get:/api/users:');
  });
  assert.equal(endpointToControllerEdges.length, 1);
  assert.ok(endpointToControllerEdges[0].confidence >= 0.95);

  const fetchUsersViaClient = getNodes(graph, 'Function', 'apps/dashboard/src/api/instanceClient.ts')
    .find(n => n.properties?.name === 'fetchUsersViaClient');
  assert.ok(fetchUsersViaClient);

  const instanceEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === fetchUsersViaClient.id
      && r.targetId === controllerIndex.id
      && r.reason === 'http-get:/api/users';
  });
  assert.equal(instanceEdges.length, 1);
  assert.ok(instanceEdges[0].confidence >= 0.95);

  const revokeTicket = getNodes(graph, 'Function', 'apps/dashboard/src/api/tickets.ts')
    .find(n => n.properties?.name === 'revokeTicket');
  assert.ok(revokeTicket);

  const revokeTicketController = getNodes(graph, 'Method', 'apps/backend/app/Http/Controllers/Dashboard/API/Tickets/RevokeTicketController.php')
    .find(n => n.properties?.name === '__invoke');
  assert.ok(revokeTicketController);

  const revokeEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === revokeTicket.id
      && r.targetId === revokeTicketController.id
      && r.reason === 'http-post:/api/tickets/*/revoke';
  });
  assert.equal(revokeEdges.length, 1);
  assert.ok(revokeEdges[0].confidence >= 0.9);

  const fetchFinancialAccountSummary = getNodes(graph, 'Function', 'apps/dashboard/src/api/finance.ts')
    .find(n => n.properties?.name === 'fetchFinancialAccountSummary');
  assert.ok(fetchFinancialAccountSummary);

  const financialSummaryController = getNodes(graph, 'Method', 'apps/backend/app/Http/Controllers/Dashboard/API/Finance/FinancialAccountController.php')
    .find(n => n.properties?.name === 'summary');
  assert.ok(financialSummaryController);

  const financialSummaryEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === fetchFinancialAccountSummary.id
      && r.targetId === financialSummaryController.id
      && r.reason === 'http-get:/api/accounts/*/financial_accounts/*/summary';
  });
  assert.equal(financialSummaryEdges.length, 1);
  assert.ok(financialSummaryEdges[0].confidence >= 0.9);

  const fetchPayoutAccount = getNodes(graph, 'Function', 'apps/dashboard/src/api/payoutAccount.ts')
    .find(n => n.properties?.name === 'fetchPayoutAccount');
  assert.ok(fetchPayoutAccount);

  const payoutAccountIndex = getNodes(graph, 'Method', 'apps/backend/app/Http/Controllers/Dashboard/API/Payouts/PayoutAccountController.php')
    .find(n => n.properties?.name === 'index');
  assert.ok(payoutAccountIndex);

  const payoutAccountEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === fetchPayoutAccount.id
      && r.targetId === payoutAccountIndex.id
      && r.reason === 'http-get:/api/accounts/*/payout_account';
  });
  assert.equal(payoutAccountEdges.length, 1);
  assert.ok(payoutAccountEdges[0].confidence >= 0.9);

  const fetchAccountNotifications = getNodes(graph, 'Function', 'apps/dashboard/src/api/notifications.ts')
    .find(n => n.properties?.name === 'fetchAccountNotifications');
  assert.ok(fetchAccountNotifications);

  const createAccountNotification = getNodes(graph, 'Function', 'apps/dashboard/src/api/notifications.ts')
    .find(n => n.properties?.name === 'createAccountNotification');
  assert.ok(createAccountNotification);

  const fetchAccountNotification = getNodes(graph, 'Function', 'apps/dashboard/src/api/notifications.ts')
    .find(n => n.properties?.name === 'fetchAccountNotification');
  assert.ok(fetchAccountNotification);

  const updateAccountNotification = getNodes(graph, 'Function', 'apps/dashboard/src/api/notifications.ts')
    .find(n => n.properties?.name === 'updateAccountNotification');
  assert.ok(updateAccountNotification);

  const deleteAccountNotification = getNodes(graph, 'Function', 'apps/dashboard/src/api/notifications.ts')
    .find(n => n.properties?.name === 'deleteAccountNotification');
  assert.ok(deleteAccountNotification);

  const notificationIndex = getNodes(graph, 'Method', 'apps/backend/app/Http/Controllers/Dashboard/API/Notifications/NotificationController.php')
    .find(n => n.properties?.name === 'index');
  assert.ok(notificationIndex);

  const notificationStore = getNodes(graph, 'Method', 'apps/backend/app/Http/Controllers/Dashboard/API/Notifications/NotificationController.php')
    .find(n => n.properties?.name === 'store');
  assert.ok(notificationStore);

  const notificationShow = getNodes(graph, 'Method', 'apps/backend/app/Http/Controllers/Dashboard/API/Notifications/NotificationController.php')
    .find(n => n.properties?.name === 'show');
  assert.ok(notificationShow);

  const notificationUpdate = getNodes(graph, 'Method', 'apps/backend/app/Http/Controllers/Dashboard/API/Notifications/NotificationController.php')
    .find(n => n.properties?.name === 'update');
  assert.ok(notificationUpdate);

  const notificationDestroy = getNodes(graph, 'Method', 'apps/backend/app/Http/Controllers/Dashboard/API/Notifications/NotificationController.php')
    .find(n => n.properties?.name === 'destroy');
  assert.ok(notificationDestroy);

  const endpointGetAccountNotifications = getNodes(graph, 'CodeElement', 'apps/backend/routes/dashboard.php')
    .find(n => n.properties?.name === 'endpoint:get:/api/accounts/*/notifications');
  assert.ok(endpointGetAccountNotifications);

  const fetchNotificationsEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === fetchAccountNotifications.id
      && r.targetId === notificationIndex.id
      && r.reason === 'http-get:/api/accounts/*/notifications';
  });
  assert.equal(fetchNotificationsEdges.length, 1);
  assert.ok(fetchNotificationsEdges[0].confidence >= 0.9);

  const fetchNotificationsEndpointEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === fetchAccountNotifications.id
      && r.targetId === endpointGetAccountNotifications.id
      && r.reason === 'http-get:/api/accounts/*/notifications';
  });
  assert.equal(fetchNotificationsEndpointEdges.length, 1);
  assert.ok(fetchNotificationsEndpointEdges[0].confidence >= 0.9);

  const notificationsEndpointToControllerEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === endpointGetAccountNotifications.id
      && r.targetId === notificationIndex.id
      && String(r.reason || '').startsWith('laravel-endpoint:get:/api/accounts/*/notifications:');
  });
  assert.equal(notificationsEndpointToControllerEdges.length, 1);
  assert.ok(notificationsEndpointToControllerEdges[0].confidence >= 0.95);

  const createNotificationEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === createAccountNotification.id
      && r.targetId === notificationStore.id
      && r.reason === 'http-post:/api/accounts/*/notifications';
  });
  assert.equal(createNotificationEdges.length, 1);
  assert.ok(createNotificationEdges[0].confidence >= 0.9);

  const showNotificationEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === fetchAccountNotification.id
      && r.targetId === notificationShow.id
      && r.reason === 'http-get:/api/accounts/*/notifications/*';
  });
  assert.equal(showNotificationEdges.length, 1);
  assert.ok(showNotificationEdges[0].confidence >= 0.9);

  const updateNotificationEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === updateAccountNotification.id
      && r.targetId === notificationUpdate.id
      && r.reason === 'http-patch:/api/accounts/*/notifications/*';
  });
  assert.equal(updateNotificationEdges.length, 1);
  assert.ok(updateNotificationEdges[0].confidence >= 0.9);

  const deleteNotificationEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === deleteAccountNotification.id
      && r.targetId === notificationDestroy.id
      && r.reason === 'http-delete:/api/accounts/*/notifications/*';
  });
  assert.equal(deleteNotificationEdges.length, 1);
  assert.ok(deleteNotificationEdges[0].confidence >= 0.9);

  const fetchHealth = getNodes(graph, 'Function', 'apps/dashboard/src/api/health.ts')
    .find(n => n.properties?.name === 'fetchHealth');
  assert.ok(fetchHealth);

  const healthControllerIndex = getNodes(graph, 'Method', 'apps/backend/app/Http/Controllers/HealthController.php')
    .find(n => n.properties?.name === 'index');
  assert.ok(healthControllerIndex);

  const healthEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === fetchHealth.id
      && r.targetId === healthControllerIndex.id
      && r.reason === 'http-get:/health';
  });
  assert.equal(healthEdges.length, 1);
  assert.ok(healthEdges[0].confidence >= 0.95);

  const getAuthToken = getNodes(graph, 'Function', 'apps/dashboard/src/api/auth.ts')
    .find(n => n.properties?.name === 'getAuthToken');
  assert.ok(getAuthToken);

  const loginController = getNodes(graph, 'Method', 'apps/backend/app/Http/Controllers/Mobile/Auth/LoginController.php')
    .find(n => n.properties?.name === '__invoke');
  assert.ok(loginController);

  const loginEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === getAuthToken.id
      && r.targetId === loginController.id
      && r.reason === 'http-post:/api-mobile/login';
  });
  assert.equal(loginEdges.length, 1);
  assert.ok(loginEdges[0].confidence >= 0.95);

  const toggleAcknowledgeTransaction = getNodes(graph, 'Function', 'apps/dashboard/src/api/transactions.ts')
    .find(n => n.properties?.name === 'toggleAcknowledgeTransaction');
  assert.ok(toggleAcknowledgeTransaction);

  const acknowledgeController = getNodes(graph, 'Method', 'apps/backend/app/Http/Controllers/Dashboard/API/Transactions/AcknowledgeTransactionController.php')
    .find(n => n.properties?.name === '__invoke');
  assert.ok(acknowledgeController);

  const disacknowledgeController = getNodes(graph, 'Method', 'apps/backend/app/Http/Controllers/Dashboard/API/Transactions/DisacknowledgeTransactionController.php')
    .find(n => n.properties?.name === '__invoke');
  assert.ok(disacknowledgeController);

  const acknowledgeEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === toggleAcknowledgeTransaction.id
      && r.targetId === acknowledgeController.id
      && r.reason === 'http-post:/api/transactions/*/acknowledge';
  });
  assert.equal(acknowledgeEdges.length, 1);
  assert.ok(acknowledgeEdges[0].confidence >= 0.9);

  const disacknowledgeEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === toggleAcknowledgeTransaction.id
      && r.targetId === disacknowledgeController.id
      && r.reason === 'http-post:/api/transactions/*/unacknowledge';
  });
  assert.equal(disacknowledgeEdges.length, 1);
  assert.ok(disacknowledgeEdges[0].confidence >= 0.9);
});

test('Full-stack: frontend literal route strings wire to Laravel controller methods', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const useDownloadAccessUrl = getNodes(graph, 'Function', 'apps/dashboard/src/customHooks/useDownloadAccessUrl.ts')
    .find(n => n.properties?.name === 'useDownloadAccessUrl');
  assert.ok(useDownloadAccessUrl);

  const downloadAccessController = getNodes(graph, 'Method', 'apps/backend/app/Http/Controllers/Dashboard/DownloadAccessController.php')
    .find(n => n.properties?.name === '__invoke');
  assert.ok(downloadAccessController);

  const literalEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === useDownloadAccessUrl.id
      && r.targetId === downloadAccessController.id
      && r.reason === 'http-literal-get:/dashboard/downloads/*/access-file';
  });
  assert.equal(literalEdges.length, 1);
  assert.ok(literalEdges[0].confidence >= 0.75);
});

test('Dashboard: React Query key factories wire to API wrapper functions', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const usersQueryKeyFactory = getNodes(graph, 'Function', 'apps/dashboard/src/queries/usersQueryKeys.ts')
    .find(n => n.properties?.name === 'usersQueryKeys.all');
  assert.ok(usersQueryKeyFactory);

  const fetchUsersViaClient = getNodes(graph, 'Function', 'apps/dashboard/src/api/instanceClient.ts')
    .find(n => n.properties?.name === 'fetchUsersViaClient');
  assert.ok(fetchUsersViaClient);

  const controllerIndex = getNodes(graph, 'Method', 'app/Http/Controllers/UserController.php')
    .find(n => n.properties?.name === 'index');
  assert.ok(controllerIndex);

  const edges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === usersQueryKeyFactory.id
      && r.targetId === fetchUsersViaClient.id
      && r.reason === 'react-query:key-to-query-fn';
  });
  assert.equal(edges.length, 1);
  assert.ok(edges[0].confidence >= 0.9);

  const hopEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === usersQueryKeyFactory.id
      && r.targetId === controllerIndex.id
      && r.reason === 'react-query:key-to-http-get:/api/users';
  });
  assert.equal(hopEdges.length, 1);
  assert.ok(hopEdges[0].confidence >= 0.9);
});

test('Full-stack: does not emit cross-language fuzzy-global edges', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const callPhpOnlySymbol = getNodes(graph, 'Function', 'apps/dashboard/src/api/fuzzyGlobal.ts')
    .find(n => n.properties?.name === 'callPhpOnlySymbol');
  assert.ok(callPhpOnlySymbol);

  const phpTarget = getNodes(graph, 'Method', 'apps/backend/app/Support/FuzzyGlobalOnlyTarget.php')
    .find(n => n.properties?.name === 'gitNexusFuzzyGlobalOnlyTarget');
  assert.ok(phpTarget);

  const fuzzyEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === callPhpOnlySymbol.id
      && r.targetId === phpTarget.id
      && r.reason === 'fuzzy-global';
  });
  assert.equal(fuzzyEdges.length, 0);
});

test('Full-stack: does not emit cross-app fuzzy-global edges', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const callPhpOnlySymbol = getNodes(graph, 'Function', 'apps/dashboard/src/api/fuzzyGlobal.ts')
    .find(n => n.properties?.name === 'callPhpOnlySymbol');
  assert.ok(callPhpOnlySymbol);

  const backendTarget = getNodes(graph, 'Function', 'apps/backend/resources/js/fuzzyGlobalTarget.ts')
    .find(n => n.properties?.name === 'gitNexusBackendOnlySymbol');
  assert.ok(backendTarget);

  const fuzzyEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === callPhpOnlySymbol.id
      && r.targetId === backendTarget.id
      && r.reason === 'fuzzy-global';
  });
  assert.equal(fuzzyEdges.length, 0);
});

test('Calls: suppresses fuzzy-global edges into tests/', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const testMethod = getNodes(graph, 'Method', 'tests/FuzzyGlobalTest.php')
    .find(n => n.properties?.name === 'testFuzzyGlobalSuppressed');
  assert.ok(testMethod);

  const helperFn = getNodes(graph, 'Function', 'app/Support/FuzzyGlobalHelper.php')
    .find(n => n.properties?.name === 'gitNexusFixtureUniqueHelper');
  assert.ok(helperFn);

  const fuzzyEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === testMethod.id
      && r.targetId === helperFn.id
      && r.reason === 'fuzzy-global';
  });
  assert.equal(fuzzyEdges.length, 0);
});
