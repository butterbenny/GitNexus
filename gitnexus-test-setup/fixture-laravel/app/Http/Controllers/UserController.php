<?php

namespace App\Http\Controllers;

use App\Events\UserRegistered;
use App\Jobs\{CleanupJob as Clean, SendDigestJob};
use App\Mail\WelcomeMail;
use App\Notifications\SmsNotification;
use App\Notifications\WelcomeNotification;
use App\Services\{EmailService as Mailer, TicketService};
use Illuminate\Support\Facades\App;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Notification;
use MyVendor\Utils\Str as StrUtil;

class UserController
{
    private $service;
    private $mailer;

    public function __construct(TicketService $service)
    {
        $this->service = $service;
        $this->mailer = app(Mailer::class);
    }

    public function index(): string
    {
        StrUtil::upper('ok');
        view('emails.welcome');
        Mail::to('test@example.com')->send(new WelcomeMail());
        event(new UserRegistered());
        Event::dispatch(new UserRegistered());
        UserRegistered::dispatch();
        SendDigestJob::dispatch()->chain([
            new Clean(),
        ]);
        dispatch(new Clean());
        dispatch_sync(new Clean());
        $notifiable->notify(new WelcomeNotification());
        $notifiable->notify(new SmsNotification());
        Notification::route('slack', 'test')->notify(new WelcomeNotification());
        Notification::send([$notifiable], new WelcomeNotification());
        SendDigestJob::withChain([
            new Clean(),
        ])->dispatch();
        Bus::chain([
            new Clean(),
            new SendDigestJob(),
        ])->dispatch();
        Bus::batch([
            new Clean(),
            new SendDigestJob(),
        ])->dispatch();
        new Mailer();
        $this->mailer->send();
        app(Mailer::class)->sendViaApp();
        resolve(Mailer::class)->sendViaResolve();
        app()->make(Mailer::class)->sendViaMake();
        App::make(Mailer::class)->sendViaFacadeMake();
        $viaMake = app()->make(Mailer::class);
        $viaMake->sendViaMakeAssigned();
        $viaFacadeMake = App::make(Mailer::class);
        $viaFacadeMake->sendViaFacadeMakeAssigned();
        (new TicketService())->handleViaNew();
        return $this->service->handle();
    }
}
