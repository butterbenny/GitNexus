<?php

namespace App\Policies;

use App\Models\User;

class UserPolicy
{
    public function update(User $user): bool
    {
        return true;
    }

    public function manageMember(User $user, User $subject): bool
    {
        return true;
    }
}
