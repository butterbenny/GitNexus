<?php

namespace App\Console;

use App\Console\Commands\SendDigestCommand;
use App\Jobs\CleanupJob;
use App\Jobs\SendDigestJob;

class Kernel extends ConsoleKernel
{
    protected function schedule($schedule): void
    {
        $schedule->job(SendDigestJob::class);
        $schedule->job(new CleanupJob());
        $schedule->command(SendDigestCommand::class);
    }
}

