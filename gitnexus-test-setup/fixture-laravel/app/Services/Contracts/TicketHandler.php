<?php

namespace App\Services\Contracts;

interface TicketHandler
{
    public function handle(): string;
}

