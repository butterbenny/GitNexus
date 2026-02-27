<?php

namespace App\Services;

use App\Commands\ExampleCommand;
use App\Handlers\ExampleHandler;
use App\Http\Middleware\ExampleMiddleware;
use Joselfonseca\LaravelTactician\CommandBusInterface;

class TacticianExampleService
{
    public function __construct(
        private CommandBusInterface $bus,
    ) {
        $this->bus->addHandler(ExampleCommand::class, ExampleHandler::class);
    }

    public function run(): void
    {
        $this->bus->dispatch(new ExampleCommand(), [], [ExampleMiddleware::class]);
    }

    public function runFactory(): void
    {
        $command = ExampleCommand::make();

        $this->bus->dispatch($command, [], [ExampleMiddleware::class]);
    }
}

