<?php

namespace App\Providers;

use App\Models\User;
use App\Policies\UserPolicy;
use App\Policies\KeyablePolicies\UserPolicy as KeyableUserPolicy;

class AuthServiceProvider
{
    protected $policies = [
        User::class => UserPolicy::class,
    ];

    protected array $keyablePolicies = [
        User::class => KeyableUserPolicy::class,
    ];
}
