<?php

namespace App\Http\Controllers;

use App\Events\UserRegistered;
use App\Jobs\{CleanupJob, SendDigestJob};
use App\Mail\WelcomeMail;
use App\Services\{EmailService as Mailer, TicketService};
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Mail;
use MyVendor\Utils\Str as StrUtil;

class UserController
{
    public function index(): string
    {
        $service = new TicketService();
        StrUtil::upper('ok');
        view('emails.welcome');
        Mail::to('test@example.com')->send(new WelcomeMail());
        event(new UserRegistered());
        Event::dispatch(new UserRegistered());
        UserRegistered::dispatch();
        SendDigestJob::dispatch();
        dispatch(new CleanupJob());
        dispatch_sync(new CleanupJob());
        new Mailer();
        return $service->handle();
    }
}
