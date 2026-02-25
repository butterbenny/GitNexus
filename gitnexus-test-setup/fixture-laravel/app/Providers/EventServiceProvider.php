<?php

namespace App\Providers;

use App\Listeners\UserEventSubscriber;

class EventServiceProvider extends ServiceProvider
{
    protected $subscribe = [
        UserEventSubscriber::class,
    ];
}
