<?php

namespace App\Models\Campaign;

use App\Models\User;

class Campaign
{
    public function members()
    {
        return $this->hasMany(CampaignMember::class);
    }

    public function membersWithScope()
    {
        return $this->hasMany(CampaignMember::class)->where('active', true);
    }

    public function owner()
    {
        return $this->belongsTo(User::class);
    }

    public function items()
    {
        return $this->hasManyThrough(CampaignItem::class, CampaignItemPivot::class);
    }
}

