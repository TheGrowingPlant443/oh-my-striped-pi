#!/bin/sh
# This private fork has no public application or native-addon distribution.
printf '%s\n' \
    'oh-my-striped-pi does not provide a public installer.' \
    'Use an authenticated source checkout and your company deployment process.' \
    'From the checkout on a supported Nix platform: nix build .#omsp' \
    'Then run: ./result/bin/omsp' \
    'Upstream installers and packages install oh-my-pi, not this fork.' >&2
exit 1
