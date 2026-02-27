<?php

namespace App\Http\Controllers;

use App\Events\UserRegistered;
use App\Jobs\{CleanupJob as Clean, SendDigestJob};
use App\Http\Requests\UpdateUserRequest;
use App\Http\Resources\UserResource;
use App\Mail\WelcomeMail;
use App\Models\Campaign\Campaign;
use App\Models\User;
use App\Notifications\SmsNotification;
use App\Notifications\WelcomeNotification;
use App\Services\{EmailService as Mailer, TicketService};
use App\Domains\AccessControl\Permissions\AccountPermission;
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
        $this->service->update();
        Campaign::query()->with('members.user')->get();
        return $this->service->handle();
    }

    public function update(UpdateUserRequest $request, User $user): UserResource
    {
        $this->authorize('update', $user);
        $this->authorize(AccountPermission::EDIT, $user);
        $this->authorize('manage-member', [$user, $user]);

        return new UserResource();
    }

    public function canTest(?User $user): bool
    {
        return (bool) $user?->can('update', $user)
            && (bool) $user?->can(AccountPermission::EDIT, $user)
            && (bool) $user?->can('manage-member', [$user, $user]);
    }
}
