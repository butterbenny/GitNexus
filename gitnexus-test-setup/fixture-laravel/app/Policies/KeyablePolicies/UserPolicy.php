<?php

namespace App\Policies\KeyablePolicies;

use App\Models\User;

class UserPolicy
{
    public function view(User $user): bool
    {
        return true;
    }
}

