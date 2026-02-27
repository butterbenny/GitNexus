<?php

use Illuminate\Support\Facades\Route;

Route::prefix('accounts/{account}/financial_accounts/{financialAccount}')->group(function () {
    Route::get('summary', 'API\\Finance\\FinancialAccountController@summary');
});

Route::resource('accounts.payout_account', 'API\\Payouts\\PayoutAccountController')->only('index');

Route::post('tickets/{ticket}/revoke', 'API\\Tickets\\RevokeTicketController');

Route::post('transactions/{transaction}/acknowledge', 'API\\Transactions\\AcknowledgeTransactionController');
Route::post('transactions/{transaction}/unacknowledge', 'API\\Transactions\\DisacknowledgeTransactionController');

Route::apiResource('accounts.notifications', 'API\\Notifications\\NotificationController');
