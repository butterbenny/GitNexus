@extends('layouts.app')

@section('content')
  @include('users.partials.greeting')
  <a href="{{ route('users.index') }}">Users</a>
  <div>{{ $message }}</div>
@endsection
