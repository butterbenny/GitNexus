<?php

namespace App\Listeners;

use App\Events\UserRegistered;

class SendWelcomeEmail
{
    public function handle(UserRegistered $event): void
    {
    }
}

