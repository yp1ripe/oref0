#!/bin/bash

if [ -z "$dd" ]; then
	echo "\$dd env must be set";
	exit 1
fi

shopt -s expand_aliases

if [[ `uname` == 'Darwin' || `uname` == 'FreeBSD' || `uname` == 'OpenBSD' ]] ; then
    alias date='gdate' 
fi


echo newprofile;cp ~/myopenaps/autotune/profile.json ~/myopenaps/settings/autotune.$(date "--date=$dd +1 day" +%y%m%d).json;cp ~/myopenaps/autotune/profile.json /Users/yura/My\ Drive/t1d_tools/autotune.$(date "--date=$dd +1 day" +%y%m%d).json

