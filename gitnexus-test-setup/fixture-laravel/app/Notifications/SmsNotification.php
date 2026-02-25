<?php

namespace App\Notifications;

use Illuminate\Notifications\Notification;

class SmsNotification extends Notification
{
    public function via($notifiable)
    {
        return [SmsChannel::class];
    }

    public function toTwilio($notifiable): void
    {
    }
}

