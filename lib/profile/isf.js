'use strict';

var _ = require('lodash');

function isfLookup(isf_data, timestamp, lastResult) {

    var nowDate = timestamp;

    if (typeof(timestamp) === 'undefined') {
        nowDate = new Date();
    }

    var nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();

    if (lastResult && nowMinutes >= lastResult.offset && nowMinutes < lastResult.endOffset) {
        return [lastResult.sensitivity, lastResult];
    }

    isf_data = _.sortBy(isf_data.sensitivities, function(o) { return o.offset; });

    var isfSchedule = isf_data[isf_data.length - 1];

    if (isf_data[0].offset !== 0) {
        return [-1, lastResult];
    }

    var endMinutes = 1440;

    for (var i = 0; i < isf_data.length - 1; i++) {
        var currentISF = isf_data[i];
        var nextISF = isf_data[i+1];
        if (nowMinutes >= currentISF.offset && nowMinutes < nextISF.offset) {
            endMinutes = nextISF.offset;
            isfSchedule = isf_data[i];
            break;
        }
    }
    if( isfSchedule.sensitivity < 20 ) { 
        isfSchedule.sensitivity = Math.round( isfSchedule.sensitivity *18.018018 *10000) / 10000;
    }

    lastResult = isfSchedule;
    lastResult.endOffset = endMinutes;

    return [isfSchedule.sensitivity, lastResult];
}

isfLookup.isfLookup = isfLookup;
exports = module.exports = isfLookup;
// vim:ts=4:sw=4:et
