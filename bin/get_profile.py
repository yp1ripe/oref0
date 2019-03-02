#!/usr/bin/env python
"""
Module to ease work with nightscout profiles.
By default lists all profiles found, and supports following sub-commands:
* profiles - list defined profiles
* display - display named (or default) profile
    (in nightscout or OpenAPS format)
* save - save to disk profile in OpenAPS format

Bunch of things inspired by https://github.com/MarkMpn/AutotuneWeb/
"""

# Make it work on both python 2 and 3
# Probably a bit wide, but I'm still learning
from __future__ import absolute_import, with_statement, print_function, unicode_literals

# Built-in modules
import argparse
from datetime import datetime
import json
import logging

# External modules
import requests
from texttable import Texttable

logging.basicConfig(level=logging.INFO)


def get_profiles(nightscout, token):
    """
    Get profiles available in nightscout
    """
    r_url = nightscout + "/api/v1/profile.json"
    if token is not None:
        r_url = r_url + "?" + token
    r = requests.get(r_url)
    return r.json()


def get_current_profile(nightscout, token, profile_name):
    """
    Try to get the active profile
    """
    r_url = nightscout + "/api/v1/profile.json"
    if token is not None:
        r_url = r_url + "?" + token
    p_list = requests.get(r_url).json()
    default_profile = p_list[0]["defaultProfile"]
    if profile_name is None:
        p_url = (
            nightscout +
            "/api/v1/treatments.json?find[eventType][$eq]=Profile%20Switch&count=1"
        )
        if token is not None:
            p_url = p_url + "?" + token
        p_switch = requests.get(p_url).json()
        if p_switch:
            sw_prof = json.loads(p_switch[0]["profileJson"])
            if sw_prof:
                profile = sw_prof
                profile["name"] = p_switch[0]["profile"]
                if profile["timezone"] is not None:
                    return profile
        p_list[0]["store"][default_profile]["name"] = default_profile
        try:
            if not p_list[0]["store"][default_profile]["units"]:
                p_list[0]["store"][default_profile]["units"] = p_list[0][
                    "units"]
        except KeyError:
            p_list[0]["store"][profile_name]["units"] = p_list[0]["units"]
        return p_list[0]["store"][default_profile]
    p_list[0]["store"][profile_name]["name"] = profile_name
    try:
        if not p_list[0]["store"][profile_name]["units"]:
            p_list[0]["store"][profile_name]["units"] = p_list[0]["units"]
    except KeyError:
        p_list[0]["store"][profile_name]["units"] = p_list[0]["units"]
    return p_list[0]["store"][profile_name]


def profiles(nightscout, token):
    """
    print list of profiles available in nightscout
    """
    p_list = get_profiles(nightscout, token)
    default_profile = p_list[0]["defaultProfile"]
    profile_list = p_list[0]["store"].keys()
    print("Default profile: {}".format(default_profile))
    print("Available profiles:")
    for profile in profile_list:
        print("\t" + profile)


def display(nightscout, token, profile_name, profile_format):
    """
    Display contents of a profile, in requested format
    """
    profile = get_current_profile(nightscout, token, profile_name)
    if profile_format == "nightscout":
        # display_nightscout(p_list, profile_name)
        print("Displaying profile {}".format(profile["name"]))
        print(json.dumps(profile, indent=4))
    elif profile_format == "text":
        display_text(profile)
    else:
        print(json.dumps(ns_to_oaps(profile), indent=4))


def ns_to_oaps(ns_profile):
    """
    Convert nightscout profile to OpenAPS format
    """
    oaps_profile = {}
    # Not represented in nightscout
    oaps_profile["min_5m_carbimpact"] = 8.0
    oaps_profile["dia"] = float(ns_profile["dia"])

    # Create a list of dicts with basal profile
    oaps_profile["basalprofile"] = []
    for basal_item in ns_profile["basal"]:
        if basal_item["timeAsSeconds"] is None:
            basal_time = datetime.strptime(basal_item["time"], "%H:%M")
            basal_item[
                "timeAsSeconds"] = 3600 * basal_time.hour + 60 * basal_time.minute
        oaps_profile["basalprofile"].append({
            "i":
            len(oaps_profile["basalprofile"]),
            "minutes":
            int(basal_item["timeAsSeconds"]) / 60,
            "start":
            basal_item["time"] + ":00",
            "rate":
            float(basal_item["value"]),
        })

    # Create a dict of dicts with target levels
    oaps_profile["bg_targets"] = {
        "units": ns_profile["units"],
        "user_preferred_units": ns_profile["units"],
        "targets": [],
    }
    targets = {}
    for low in ns_profile["target_low"]:
        targets.setdefault(low["time"], {})
        targets[low["time"]]["low"] = {
            "i": len(targets),
            "start": low["time"] + ":00",
            "offset": float(low["timeAsSeconds"]),
            "low": float(low["value"]),
        }
    for high in ns_profile["target_high"]:
        targets.setdefault(high["time"], {})
        targets[high["time"]]["high"] = {"high": float(high["value"])}
    for time in sorted(targets.keys()):
        oaps_profile["bg_targets"]["targets"].append({
            "i":
            len(oaps_profile["bg_targets"]["targets"]),
            "start":
            targets[time]["low"]["start"],
            "offset":
            targets[time]["low"]["offset"],
            "low":
            targets[time]["low"]["low"],
            "min_bg":
            targets[time]["low"]["low"],
            "high":
            targets[time]["high"]["high"],
            "max_bg":
            targets[time]["high"]["high"],
        })

    # Create a dics of dicts with insulin sensitivity profile
    oaps_profile["isfProfile"] = {"first": 1, "sensitivities": []}
    isf_p = {}
    for sens in ns_profile["sens"]:
        isf_p.setdefault(sens["time"], {})
        isf_p[sens["time"]] = {
            "sensitivity": float(sens["value"]),
            "start": sens["time"] + ":00",
            "offset": int(sens["timeAsSeconds"]) / 60,
        }
    for time in sorted(isf_p.keys()):
        oaps_profile["isfProfile"]["sensitivities"].append({
            "i":
            len(oaps_profile["isfProfile"]["sensitivities"]),
            "sensitivity":
            isf_p[time]["sensitivity"],
            "offset":
            isf_p[time]["offset"],
            "start":
            isf_p[time]["start"],
        })

    # Create a dict of dicts for carb ratio
    oaps_profile["carb_ratios"] = {
        "first": 1,
        "units": "grams",
        "schedule": []
    }
    cr_p = {}
    for cr in ns_profile["carbratio"]:
        cr_p.setdefault(cr["time"], {})
        cr_p[cr["time"]] = {
            "start": cr["time"] + ":00",
            "offset": int(cr["timeAsSeconds"]) / 60,
            "ratio": float(cr["value"]),
        }
    for time in sorted(cr_p.keys()):
        oaps_profile["carb_ratios"]["schedule"].append({
            "i":
            len(oaps_profile["carb_ratios"]["schedule"]),
            "start":
            cr_p[time]["start"],
            "offset":
            cr_p[time]["offset"],
            "ratio":
            cr_p[time]["ratio"],
        })
    oaps_profile["carb_ratio"] = oaps_profile["carb_ratios"]["schedule"][0][
        "ratio"]

    return oaps_profile


def display_nightscout(profile_data, profile_name):
    """
    Display profile the way it comes from nightscout
    """
    print("Displaying profile {}".format(profile_name))
    print(json.dumps(profile_data[0]["store"][profile_name], indent=4))


def display_text(p_data):
    """
    Display profile in text format
    """
    # p_data = profile_data[0]["store"][profile_name]
    logging.debug("Data keys: %s", p_data.keys())

    # Single value data
    singletons = Texttable()
    singletons.set_deco(Texttable.HEADER)
    singletons.set_cols_align(["c", "c", "c", "c", "c", "c"])
    singletons.add_rows([
        ["Profile name", "Timezone", "Units", "DIA", "Delay", "Start date"],
        [
            p_data["name"],
            p_data["timezone"],
            p_data["units"],
            p_data["dia"],
            p_data["delay"],
            p_data["startDate"],
        ],
    ])
    print(singletons.draw() + "\n")

    times = {}
    tgt_low = {v["time"]: v["value"] for v in p_data["target_low"]}
    tgt_high = {v["time"]: v["value"] for v in p_data["target_high"]}
    carb_ratio = {v["time"]: v["value"] for v in p_data["carbratio"]}
    sens = {v["time"]: v["value"] for v in p_data["sens"]}
    basal = {v["time"]: v["value"] for v in p_data["basal"]}
    logging.debug(tgt_high, tgt_low, carb_ratio, sens, basal)
    for (time, basal) in basal.items():
        times.setdefault(time, {})
        times[time]["basal"] = basal
    for (time, sens) in sens.items():
        times.setdefault(time, {})
        times[time]["sens"] = sens
    for (time, c_r) in carb_ratio.items():
        times.setdefault(time, {})
        times[time]["carbratio"] = c_r
    for (time, tgt_h) in tgt_high.items():
        times.setdefault(time, {})
        times[time]["tgt_high"] = tgt_h
    for (time, tgt_l) in tgt_low.items():
        times.setdefault(time, {})
        times[time]["tgt_low"] = tgt_l
    logging.debug("Times: %s", times)

    times_list = [["Time", "Basal", "ISF", "CR", "Target Low", "Target High"]]
    for time in sorted(times.keys()):
        times_list.append([
            time,
            times[time].get("basal", ""),
            times[time].get("sens", ""),
            times[time].get("carbratio", ""),
            times[time].get("tgt_low", ""),
            times[time].get("tgt_high", ""),
        ])
    times_table = Texttable()
    times_table.set_cols_align(["c", "c", "c", "c", "c", "c"])
    times_table.add_rows(times_list)
    print(times_table.draw() + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Get nightscout profile.")
    parser.add_argument(
        "--nightscout",
        help="Nightscout URL",
        required=True,
        nargs="?",
        const="http://127.0.0.1:1337",
        default="http://127.0.0.1:1337",
    )
    parser.add_argument("--token", help="Authenticaton token")

    subparsers = parser.add_subparsers(
        help="Sub-command to run", dest="subparser")

    parser_profiles = subparsers.add_parser(
        "profiles", help="List all profile names")

    parser_display = subparsers.add_parser("display", help="Display a profile")
    parser_display.add_argument(
        "--name",
        help="Which profile to display",
        nargs="?",
        dest="profile_name")
    parser_display.add_argument(
        "--format",
        default="nightscout",
        nargs="?",
        dest="profile_format",
        choices=["nightscout", "openaps", "text"],
        help="What format to display profile in",
    )

    logging.debug(vars(parser.parse_args()))

    # https://stackoverflow.com/questions/4575747/get-selected-subcommand-with-argparse/44948406#44948406
    # I have no idea what it does, but it seems to do the trick
    kwargs = vars(parser.parse_args())
    globals()[kwargs.pop("subparser")](**kwargs)
