from __future__ import annotations

import argparse

from . import export, finalize, hub, index, scan
from .settings import Settings


def main() -> None:
    from . import __doc__ as doc
    parser = argparse.ArgumentParser(prog="w4c", description=doc, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="stage", required=True)
    for module in (scan, index, export, finalize, hub):
        module.add_parser(sub)
    args = parser.parse_args()
    settings = Settings.from_env()
    args.func(settings, args)


if __name__ == "__main__":
    main()
