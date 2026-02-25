<?php

namespace MyVendor\Utils;

class Str
{
    public static function upper(string $value): string
    {
        return strtoupper($value);
    }
}

