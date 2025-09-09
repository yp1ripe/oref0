#!/bin/bash

if [ -z "$dd" ]; then
	echo "\$dd env must be set";
	exit 1
fi

./bin/get_profile.py --nightscout https://nikacgm1.herokuapp.com display --format openaps --minimpact 8.0 --autosens-min 0.8 --autosens-max 1.25 >  ~/myopenaps/settings/profile.$dd.json

cp ~/myopenaps/settings/profile.$dd.json ~/myopenaps/settings/profile.json; cp ~/myopenaps/settings/profile.json ~/myopenaps/settings/pumpprofile.json


