<?php

namespace App\Services;

class TicketService
{
    public function handle(): string
    {
        return $this->format('ok');
    }

    private function format(string $value): string
    {
        return strtoupper($value);
    }
}

