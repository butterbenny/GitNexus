<?php

namespace App\Domains\AccessControl\Permissions;

enum AccountPermission: string
{
    case ALL = 'account.*';
    case VIEW = 'account.view';
    case EDIT = 'account.edit';

    public static function allExcept(array $except): array
    {
        return array_values(array_filter(
            self::cases(),
            static fn ($case) => $case !== self::ALL && !in_array($case, $except, true),
        ));
    }
}
