function insulinDosed(opts) {

    var start = opts.start.getTime();
    var end = opts.end.getTime();
    var treatments = opts.treatments;
    var profile_data = opts.profile;
    var insulinDosed = 0;
    var basalDosed = 0;
    var bolusDosed = 0;
    var debug = opts.debug;
    if (!treatments) {
        console.error("No treatments to process.");
        return {};
    }

    treatments.forEach(function(treatment) {
        if(treatment.insulin && treatment.date >= start && treatment.date <= end) {
            if(debug)console.error(treatment);
            insulinDosed += treatment.insulin;
            if(treatment.insulin < 0.1 ) {
		basalDosed += treatment.insulin;
            } else {
		bolusDosed += treatment.insulin;
            }
        }
    });
    if (debug)console.error(opts.start.toLocaleTimeString(),"-",opts.end.toLocaleTimeString(),"insulinDosed=",insulinDosed," bolus ",bolusDosed," basal ", basalDosed);

    return {
        insulin: Math.round( insulinDosed * 1000 ) / 1000
      , basal: Math.round( basalDosed * 1000 )/1000
      , bolus: Math.round( bolusDosed * 1000 )/1000
    };
}

exports = module.exports = insulinDosed;
