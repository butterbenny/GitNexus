<?php

namespace App\Notifications;

use Illuminate\Notifications\Notification;

class SmsChannel extends TwilioChannel
{
    public function send($notifiable, Notification $notification): void
    {
        // Delegate to parent channel (which calls Notification->toTwilio()).
        parent::send($notifiable, $notification);
    }
}

