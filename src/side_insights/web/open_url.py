"""usage: python3 -m side_insights open-url <url>"""
import sys

from side_insights.system import open_url

if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    sys.exit(0 if open_url(sys.argv[1]) else 1)
