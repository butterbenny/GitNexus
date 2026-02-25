<?php

use App\Http\Controllers\UserController as Controller;
use Illuminate\Support\Facades\Route;

Route::get('/users', [Controller::class, 'index'])->name('users.index');
