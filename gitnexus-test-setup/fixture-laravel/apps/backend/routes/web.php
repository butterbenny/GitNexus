<?php

use App\Http\Controllers\Dashboard\DownloadAccessController;
use Illuminate\Support\Facades\Route;

Route::prefix('dashboard')->group(function () {
    Route::get('downloads/{download}/access-file', DownloadAccessController::class);
});

