<?php

namespace App\Providers;

use Illuminate\Foundation\Support\Providers\RouteServiceProvider as ServiceProvider;
use Illuminate\Support\Facades\Route;

class RouteServiceProvider extends ServiceProvider
{
    /**
     * The controller namespace for the application.
     *
     * @var string|null
     */
    protected $namespace = 'App\Http\Controllers';

    public function map(): void
    {
        $this->mapApiRoutes();
        $this->mapDashboardRoutes();
        $this->mapMobileRoutes();
    }

    protected function mapApiRoutes(): void
    {
        Route::domain('api.example.com')
            ->middleware('api')
            ->namespace($this->namespace)
            ->group(base_path('routes/api.php'));
    }

    protected function mapDashboardRoutes(): void
    {
        Route::prefix('api')
            ->middleware('api')
            ->namespace($this->namespace . '\Dashboard')
            ->group(base_path('routes/dashboard.php'));
    }

    protected function mapMobileRoutes(): void
    {
        Route::prefix('api-mobile')
            ->middleware('api')
            ->namespace($this->namespace)
            ->group(base_path('routes/mobile.php'));
    }
}
