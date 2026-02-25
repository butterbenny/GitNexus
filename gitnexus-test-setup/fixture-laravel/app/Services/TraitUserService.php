<?php

namespace App\Services;

use App\Traits\DoesThing;

class TraitUserService
{
    use DoesThing;

    public function handle(): void
    {
        $this->doThing();
    }
}

