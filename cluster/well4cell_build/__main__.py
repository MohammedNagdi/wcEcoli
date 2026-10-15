from __future__ import annotations

import argparse

from . import deg_rates, export, finalize, hub, index, scan, summarize
from .settings import Settings


def main() -> None:
    from . import __doc__ as doc
    parser = argparse.ArgumentParser(prog="w4c", description=doc, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="stage", required=True)
    for module in (scan, index, export, finalize, summarize, deg_rates, hub):
        module.add_parser(sub)
    args = parser.parse_args()
    settings = Settings.from_env()
    args.func(settings, args)


if __name__ == "__main__":
    main()
