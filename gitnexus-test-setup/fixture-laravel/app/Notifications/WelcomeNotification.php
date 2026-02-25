<?php

namespace App\Notifications;

use Illuminate\Notifications\Notification;
use Illuminate\Notifications\Messages\MailMessage;

class WelcomeNotification extends Notification
{
    public function via($notifiable)
    {
        return ['mail', 'slack'];
    }

    public function toMail($notifiable): MailMessage
    {
        return (new MailMessage())
            ->markdown('emails.welcome');
    }

    public function toSlack($notifiable): void
    {
    }
}
