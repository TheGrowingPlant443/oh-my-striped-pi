# This private fork has no public application or native-addon distribution.
throw @"
oh-my-striped-pi does not provide a public installer.
Use an authenticated source checkout and your company deployment process.
On a supported Nix platform, run from the checkout: nix build .#omsp
Then run: ./result/bin/omsp
Upstream installers and packages install oh-my-pi, not this fork.
"@
