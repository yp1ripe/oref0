'use strict';

function iobTotal(opts, time) {

    var now = time.getTime();
    var iobCalc = opts.calculate;
    var treatments = opts.treatments;
    var profile_data = opts.profile;
    var debug = opts.debug_iob_total;
    var absorptionPeriods = ( "absorptionPeriods" in opts && opts.absorptionPeriods !== null ) ? opts.absorptionPeriods : null;
    if ( debug ) console.error("absorptionPeriods ", opts.absorptionPeriods );
    var dia = profile_data.dia;
    var peak = 0;
    var iob = 0;
    var basaliob = 0;
    var bolusiob = 0;
    var netbasalinsulin = 0;
    var bolusinsulin = 0;
    //var bolussnooze = 0;
    var activity = 0;
    var basalActivity = 0;
    var bolusActivity = 0;
    var mealBasalActivityCorrection = 0;
    if (!treatments) return {};
    //if (typeof time === 'undefined') {
        //var time = new Date();
    //}

    // force minimum DIA of 3h
    if (dia < 3) {
        //console.error("Warning; adjusting DIA from",dia,"to minimum of 3 hours");
        dia = 3;
    }

    var curveDefaults = {
        'bilinear': {
            requireLongDia: false,
            peak: 75 // not really used, but prevents having to check later
        },
        'rapid-acting': {
            requireLongDia: true,
            peak: 75,
            tdMin: 300
        },
        'ultra-rapid': {
            requireLongDia: true,
            peak: 55,
            tdMin: 300
        },
    };

    var curve = 'bilinear';

    if (profile_data.curve !== undefined) {
        curve = profile_data.curve.toLowerCase();
    }

    if (!(curve in curveDefaults)) {
        console.error('Unsupported curve function: "' + curve + '". Supported curves: "bilinear", "rapid-acting" (Novolog, Novorapid, Humalog, Apidra) and "ultra-rapid" (Fiasp). Defaulting to "rapid-acting".');
        curve = 'rapid-acting';
    }

    var defaults = curveDefaults[curve];

    // Force minimum of 5 hour DIA when default requires a Long DIA.
    if (defaults.requireLongDia && dia < 5) {
        //console.error('Pump DIA must be set to 5 hours or more with the new curves, please adjust your pump. Defaulting to 5 hour DIA.');
        dia = 5;
    }

    peak = defaults.peak;
    var assoc = {}
    var dia_ago = now - dia*60*60*1000;
    var period = null;
    if ( absorptionPeriods !== null ) {
        period =  absorptionPeriods.find((el) => dia_ago <= el[1] && now >= el[0] && now <= el[1]);
        if ( typeof(period ) === 'undefined' ) period = null;
    }
    treatments.forEach(function(treatment) {
        var corr = 0;
        var corrQuants = 0;
        if( treatment.date <= now ) {
            if( treatment.date >= dia_ago ) {
                // tIOB = total IOB
                var tIOB = iobCalc(treatment, time, curve, dia, peak, profile_data);
                if (tIOB && tIOB.iobContrib) { iob += tIOB.iobContrib; }
                if (tIOB && tIOB.activityContrib) { activity += tIOB.activityContrib; }
                // basals look like either of these:
                // {"insulin":-0.05,"date":1507265512363.6365,"created_at":"2017-10-06T04:51:52.363Z"}
                // {"insulin":0.05,"date":1507266530000,"created_at":"2017-10-06T05:08:50.000Z"}
                // boluses look like:
                // {"timestamp":"2017-10-05T22:06:31-07:00","started_at":"2017-10-06T05:06:31.000Z","date":1507266391000,"insulin":0.5}
                if (treatment.insulin && tIOB && tIOB.iobContrib) {
                    if (treatment.insulin < 0.1 ) {
                        basaliob += tIOB.iobContrib;
                        if ( tIOB &&  tIOB.activityContrib ) {basalActivity += tIOB.activityContrib;}
                        if ( tIOB &&  tIOB.activityContrib &&  absorptionPeriods != null &&
                                typeof(absorptionPeriods.find(  function(el,idx,arr) {
                                                                    var ret =  ( treatment.date <= el[1] && treatment.date >= el[0]);
                                                                    //if( debug ) console.error( "find ",treatment.created_at," ",el," res ",ret);
                                                                    return ret;
                                                                }
                                                             )
                                ) !== 'undefined'
                           )  {
                                mealBasalActivityCorrection += tIOB.activityContrib;
                                corr =  tIOB.activityContrib;
                        } else {
                           corr = 0;
                        }
                        netbasalinsulin += treatment.insulin;
                        if(debug && treatment.hasOwnProperty("grouping") ){
                            if (assoc[treatment.grouping] == null ) {
                                assoc[treatment.grouping] =   {
                                    iobContrib:  0,
                                    activityContrib: 0,
                                    mealBasalActivityCorrection: 0,
                                    netBI: 0,
                                    quants: 0,
                                    corrQuants: 0
                                };
                            }
                            assoc[treatment.grouping].iobContrib += tIOB.iobContrib;
                            assoc[treatment.grouping].activityContrib += tIOB.activityContrib;
                            assoc[treatment.grouping].netBI += treatment.insulin;
                            assoc[treatment.grouping].quants++;
                            if( corr !=0 )assoc[treatment.grouping].corrQuants++;
                            assoc[treatment.grouping].mealBasalActivityCorrection += corr;
                        }
                    } else {
                        bolusiob += tIOB.iobContrib;
                        if ( tIOB &&  tIOB.activityContrib ) {bolusActivity += tIOB.activityContrib;}
                        bolusinsulin += treatment.insulin;
                    }
                }
                //console.error(JSON.stringify(treatment));
                //console.error("t.date",treatment.date,"t.insulin",treatment.insulin);
            }
        } // else { console.error("ignoring future treatment:",treatment); }
    });
    if( debug ) {
	    Object.keys(assoc).reverse().forEach(function(key)  {
                console.error("basal-contrib: "+key+" "+
			(Math.round(assoc[key].iobContrib * 1000)/1000).toFixed(3).padStart(6,' ')+"/"+
			(Math.round(assoc[key].netBI * 1200 )/1200).toFixed(4).padStart(7,' ')+" act "+
			(Math.round(assoc[key].activityContrib * 100000 )/100000).toFixed(5).padStart(8,' ') +' corr '+
			(Math.round(assoc[key].mealBasalActivityCorrection * 100000 )/100000).toFixed(5).padStart(8,' ') +
				' quants '+assoc[key].quants + ' corrQuants '+assoc[key].corrQuants
		);
            }	
	    );
    }


    var ret =  {
        iob: Math.round(iob * 1000) / 1000,
        activity: Math.round(activity * 100000) / 100000,
        basalActivity: Math.round( basalActivity * 100000) / 100000,
        bolusActivity: Math.round( bolusActivity * 100000) / 100000,
        basaliob: Math.round(basaliob * 1000) / 1000,
        bolusiob: Math.round(bolusiob * 1000) / 1000,
        netbasalinsulin: Math.round(netbasalinsulin * 1000) / 1000,
        bolusinsulin: Math.round(bolusinsulin * 1000) / 1000,
        mealBasalActivityCorrection: Math.round(mealBasalActivityCorrection * 100000) / 100000,
        time: time
    };
    if( debug ) {
        console.error( ret );
    }
    return ret;
}

exports = module.exports = iobTotal;
// vim:et:ts=4:sw=4
