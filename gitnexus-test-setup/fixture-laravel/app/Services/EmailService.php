<?php

namespace App\Services;

class EmailService
{
    public function send(): void
    {
    }

    public function usersIndexUrl(): string
    {
        return route('users.index');
    }
}
