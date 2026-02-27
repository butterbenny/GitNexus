<?php

namespace App\Models\Campaign;

use App\Models\User;

class CampaignMember
{
    public function user()
    {
        return $this->belongsTo(User::class);
    }
}
