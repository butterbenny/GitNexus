<?php

namespace App\Mail;

class WelcomeMail
{
    public function build(): void
    {
        $this->view('emails.welcome');
    }
}

