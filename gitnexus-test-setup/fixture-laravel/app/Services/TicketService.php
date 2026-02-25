<?php

namespace App\Services;

use App\Services\Contracts\TicketHandler;

class TicketService extends BaseService implements TicketHandler
{
    public function handle(): string
    {
        return $this->format('ok');
    }

    public function handleViaNew(): void
    {
    }

    private function format(string $value): string
    {
        return strtoupper($value);
    }
}
