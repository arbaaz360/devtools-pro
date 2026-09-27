import email.utils
import json
import sys
import datetime

cases = [
    ("Tue, 14 Nov 2023 22:13:20 +0000", "rfc5322"),
    ("Tue, 14 Nov 2023 22:13:20 GMT", "imf-fixdate"),
    ("14 Nov 2023 22:13:20 -0500", "rfc5322"),
    ("Tue, 14 Nov 2023 22:13 +0530", "rfc5322"),
    ("Tuesday, 14-Nov-23 22:13:20 GMT", "rfc850"),
    ("Tue, 14 Nov 2023 17:13:20 EST", "rfc5322"),
    ("Tue, 14 Nov 2023 14:13:20 PST", "rfc5322"),
    ("Sun, 06 Nov 1994 08:49:37 GMT", "imf-fixdate"),
    ("Sunday, 06-Nov-94 08:49:37 GMT", "rfc850"),
    ("Sun Nov  6 08:49:37 1994", "asctime"),
    ("Fri, 21 Nov 1997 09:55:06 -0600", "rfc5322")
]

results = []
for input_str, interp in cases:
    dt = email.utils.parsedate_to_datetime(input_str)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    expected = int(dt.timestamp() * 1000)
    results.append({"input": input_str, "expected": expected, "interp": interp})

json.dump(results, sys.stdout, indent=2)
