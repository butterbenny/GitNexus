<?php

use App\Domains\AccessControl\Permissions\AccountPermission;

return [
    'roles' => [
        'finance' => [
            'permissions' => [
                AccountPermission::VIEW,
                AccountPermission::EDIT,
            ],
        ],
        'administrator' => [
            'permissions' => [
                AccountPermission::ALL,
            ],
        ],
        'editor' => [
            'permissions' => [
                ...AccountPermission::allExcept([
                    AccountPermission::EDIT,
                ]),
            ],
        ],
    ],
];

