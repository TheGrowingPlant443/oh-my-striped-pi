{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.omsp;
in
{
  options.programs.omsp = {
    enable = lib.mkEnableOption "OMSP coding agent";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.omsp.packages.${pkgs.stdenv.hostPlatform.system}.default";
      description = "OMSP package to install system-wide.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];
  };
}
