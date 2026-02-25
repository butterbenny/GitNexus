<?php

use Illuminate\Support\Facades\Route;

Route::prefix('accounts/{account}/financial_accounts/{financialAccount}')->group(function () {
    Route::get('summary', 'API\\Finance\\FinancialAccountController@summary');
});

Route::resource('accounts.payout_account', 'API\\Payouts\\PayoutAccountController')->only('index');

Route::post('tickets/{ticket}/revoke', 'API\\Tickets\\RevokeTicketController');
