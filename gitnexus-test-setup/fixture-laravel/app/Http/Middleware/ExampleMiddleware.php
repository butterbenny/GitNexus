<?php

namespace App\Http\Middleware;

use League\Tactician\Middleware;

class ExampleMiddleware implements Middleware
{
    public function execute($command, callable $next)
    {
        return $next($command);
    }
}

