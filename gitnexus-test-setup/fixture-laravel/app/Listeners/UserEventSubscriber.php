<?php

namespace App\Listeners;

use App\Events\UserRegistered;

class UserEventSubscriber
{
    public function subscribe($events): void
    {
        $events->listen(UserRegistered::class, SendWelcomeEmail::class);
        $events->listen(UserRegistered::class, [self::class, 'onUserRegistered']);
    }

    public function onUserRegistered(UserRegistered $event): void
    {
    }
}
