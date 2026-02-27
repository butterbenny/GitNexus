<?php

namespace App\Http\Resources;

class CampaignResource
{
    public function toArray(): array
    {
        return [
            'members' => $this->whenLoaded('members.user'),
        ];
    }
}

