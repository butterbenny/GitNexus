<?php

namespace App\Http\Controllers;

class NestedController
{
    public function index(): void
    {
        view('emails.nested');
    }
}

