<?php

namespace App\Services;

use App\Domains\AccessControl\Permissions\AccountPermission;
use App\Services\Contracts\TicketHandler;

class TicketService extends BaseService implements TicketHandler
{
    public function handle(): string
    {
        return $this->format('ok');
    }

    public function update(): void
    {
    }

    public function permissionFor(string $mode): AccountPermission
    {
        return match ($mode) {
            'view' => AccountPermission::VIEW,
            default => AccountPermission::EDIT,
        };
    }

    public function handleViaNew(): void
    {
    }

    private function format(string $value): string
    {
        return strtoupper($value);
    }
}
