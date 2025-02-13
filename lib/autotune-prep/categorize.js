'use strict';

var tz = require('moment-timezone');
const {KalmanFilter} = require('kalman-filter');
var basal = require('../profile/basal');
var getIOB = require('../iob');
var ISF = require('../profile/isf');
var Carbs = require('../profile/carbs');
var find_insulin = require('../iob/history');
var dosed = require('./dosed');
var percentile = require('../percentile');
var _ = require('lodash');

const MGDL2MMOL = 0.0555;
//const BOLUS_ACTIVITY_FRACTION_THRESHOLD = 23/32;
//const BOLUS_ACTIVITY_FRACTION_THRESHOLD = 7/12;
const BOLUS_ACTIVITY_FRACTION_THRESHOLD = 1/2;
// main function categorizeBGDatums. ;) categorize to ISF, CSF, or basals.

const tPISAmax = 75;
const tPISAdropout = 15;
const  GinPISA = -0.98;
var   GDinPISA = GinPISA;
const GoutPISA = -2.8;
const Gratio = 1.2;
const GratioMin = 0.9;
const GratioMax = 1.1;
var GvIN = 0;
var PISA = false;
var opt_PISA = true;
var iPISA = 0;
var need_uptick = false;
var uptick = false;

function categorizeBGDatums(opts) {
    let sumAct=0;
    let maxBG =0;
    let sumLag =0;
    let TDDBolusAct =0;
    let TDDBasalAct =0;
    let TDDDownAct =0;
    let TDDDownDelta =0;
    let TDDZeroAct =0;
    let TDDZeroDelta =0;
    let TDDUpAct =0;
    let TDDUpDelta =0;
    var treatments = opts.treatments;
    // & 1 - lib/iob/total.js temp basals stuff each iteration
    // & 2 - lib/iob/total.js temp basals stuff each iteration
    // & 4 - categorization:if glucose entry is isf or uam or basal
    // & 8 - used in lib/autotune/index.js - basals summary
    // & 16 - wizard entires
    // & 32 - meals insulin dosed
    // & 64 - ISF ratios array dump each iteration
    var debug_wizard =   opts.dbg_output != null ? (opts.dbg_output & 16 )  : false;
    var debug_meal_dosed =   opts.dbg_output != null ? (opts.dbg_output & 32 )  : false;
    var debug_ratios =   opts.dbg_output != null ? (opts.dbg_output & 64 )  : false;
    var debug_categ = opts.dbg_output != null && opts.dbg_output & 4 ? true : false;
    opt_PISA=opts.detect_PISA;
    // this sorts the treatments collection in order.
    treatments.sort(function (a, b) {
        var aDate = new Date(tz(a.timestamp));
        var bDate = new Date(tz(b.timestamp));

        var ret  = bDate.getTime() - aDate.getTime();
        if ( (ret == 0 || Math.abs(ret) < 1000) && "bolusCalc" in a ) {
            //console.error( "Sort return 1");
            //console.error( "a",a);
            //console.error( "b",b);
            return 1;
        } else if ( (ret == 0 || Math.abs(ret) < 1000)  && "bolusCalc" in b ) {
            //console.error( "Sort return -1");
            //console.error( "a",a);
            //console.error( "b",b);
            return -1;
        } else
            return ret;
    });
    var profileData = opts.profile;

    var glucoseData = [ ];
    if (typeof(opts.glucose) !== 'undefined') {
        //var glucoseData = opts.glucose;
        glucoseData = opts.glucose.map(function prepGlucose (obj) {
            //Support the NS sgv field to avoid having to convert in a custom way
            obj.glucose = obj.glucose || obj.sgv;

            if (obj.date) {
                //obj.BGTime = new Date(obj.date);
            } else if (obj.displayTime) {
                // Attempt to get date from displayTime
                obj.date = new Date(obj.displayTime.replace('T', ' ')).getTime();
            } else if (obj.dateString) {
                // Attempt to get date from dateString
                obj.date = new Date(obj.dateString).getTime();
            }// else { console.error("Could not determine BG time"); }

            if (!obj.dateString)
            {
                obj.dateString = new Date(tz(obj.date)).toISOString();
            }
            return obj;
        }).filter(function filterRecords(obj) {
            // Only take records with a valid date record
            // and a glucose value, which is also above 39
            return (obj.date && obj.glucose && obj.glucose >=39 && ("isValid" in obj && obj.isValid == true || !("isValid" in obj)));
        }).sort(function (a, b) {
            // sort the collection in order
            return b.date - a.date;
        });
    }
    // if (typeof(opts.preppedGlucose) !== 'undefined') {
        // var preppedGlucoseData = opts.preppedGlucose;
    // }
    //starting variable at 0
    var boluses = 0;
    var maxCarbs = 0;
    //console.error(treatments);
    if (!treatments) return {};

    //console.error(glucoseData);
    var IOBInputs = {
        profile: profileData
    ,   history: opts.pumpHistory
    ,   debug: opts.dbg_output != null ? (opts.dbg_output & 2 )  : false
    ,   split30: opts.split30
    };
    var CSFGlucoseData = [];
    var ISFGlucoseData = [];
    var basalGlucoseData = [];
    var UAMGlucoseData = [];
    var CRData = [];
    var savedMyCarbs = 0;
    var extendedCarbsTill = 0;

    var bucketedData = [];
    var toKalmanFilter = [];
    bucketedData[0] = JSON.parse(JSON.stringify(glucoseData[0]));
    var j=0;
    var k=0; // index of first value used by bucket
    //for loop to validate and bucket the data
    for (var i=0; i < glucoseData.length; i++) {
        var BGTime = glucoseData[i].date;
        var lastBGTime = glucoseData[k].date;
        var elapsedMinutes = (BGTime - lastBGTime)/(60*1000);

        if(Math.abs(elapsedMinutes) >= 2) {
            j++; // move to next bucket
            k=i; // store index of first value used by bucket
            bucketedData[j]=JSON.parse(JSON.stringify(glucoseData[i]));
        } else {
            // average all readings within time deadband
            var glucoseTotal = glucoseData.slice(k, i+1).reduce(function(total, entry) {
                return total + entry.glucose;
            }, 0);
            bucketedData[j].glucose = glucoseTotal / (i-k+1);
        }
        toKalmanFilter[glucoseData.length - 1 - j] = [ bucketedData[j].glucose];
    }

    if( opt_PISA ) {
        console.error(toKalmanFilter);
        toKalmanFilter.filter(function () { return true } );
        console.error(toKalmanFilter);
        const kFilter = new KalmanFilter({observation:   1  });
        const kFilRes = kFilter.filterAll(toKalmanFilter)
        //console.error(kFilRes);
        for( i = bucketedData.length-1; i>=0 ; i--) {
            bucketedData[i].smoothed = kFilRes[bucketedData.length - i - 1][0];
            if( i < bucketedData.length-1)
                bucketedData[i].Gv = (bucketedData[i].glucose-bucketedData[i+1].glucose)/((bucketedData[i].date-bucketedData[i+1].date)/60000);
            //console.error(i,bucketedData.length - i - 1, bucketedData[i].smoothed, bucketedData[i].Gv)
        }
    }
    //console.error(bucketedData);
    //console.error(bucketedData[bucketedData.length-1]);
    // go through the treatments and remove any that are older than the oldest glucose value
    //console.error(treatments);
    for (i=treatments.length-1; i>0; --i) {
        var treatment = treatments[i];
        //console.error(treatment);
        if (treatment) {
            var treatmentDate = new Date(tz(treatment.timestamp));
            var treatmentTime = treatmentDate.getTime();
            var glucoseDatum = bucketedData[bucketedData.length-1];
            //console.error(glucoseDatum);
            if (glucoseDatum) {
                var BGDate = new Date(glucoseDatum.date);
                BGTime = BGDate.getTime();
                if ( treatmentTime < BGTime ) {
                    treatments.splice(i,1);
                }
            }
        }
    }
    //console.error(treatments);
    var calculatingCR = false;
    var absorbing = 0;
    var uam = 0; // unannounced meal
    var mealCOB = 0;
    var mealCarbs = 0;
    var CRCarbs = 0;
    var CRInitialBG = null;
    var CRMaxBG =  {
        val:    0,
        time:   null
    };
    var CRMinBG =  {
        val:    null,
        time:   null
    };
    var type="";
    var savedI = 0;
    // main for loop
    var fullHistory = IOBInputs.history;
    var lastIsfResult = null;
    var tempImpact = 0;
    var impactDecay = [];
    var end_meal_avgdev = 0.0;
    if( "end_meal_if_avgdev_le" in opts && ( opts.end_meal_if_avgdev_le < 0.0 || opts.end_meal_if_avgdev_le > 0.0 ) ) {
        end_meal_avgdev = opts.end_meal_if_avgdev_le;
    }
    var limit_decay_time = false;
    if( "limit_carbs_decay_time" in opts && opts.limit_carbs_decay_time) {
	   limit_decay_time=opts.limit_carbs_decay_time;
    }
    var intervalDataISF = null;
    var wizardCarbsPending = 0;
    var wizardInsulinPending = 0;
    var wizardInsulinIOB = null;
    var latestWizard = null;
    var CRInitialIOB = null;
    var CRInitialIOBTime = null;
    var CRInitialCarbTime = null;
    var minBGDate = null;
    for (i=bucketedData.length-5; i >= 0; --i) {
        glucoseDatum = bucketedData[i];
        //console.error("raw ",glucoseDatum.glucose,"smoothed",glucoseDatum.smoothed);
        if( typeof(iob) !== 'undefined' ) {
            var prevIob = iob;
        }
        var prevGlucoseDatum = bucketedData[i+1];
        BGDate = new Date(glucoseDatum.date);
        var prevBGDate = new Date(bucketedData[i+1].date);
        var lag = BGDate - prevBGDate ;
        var lagMinutes = Math.round(  lag /  60000 );
        BGTime = BGDate.getTime();
        var profile = profileData;

        // As we're processing each data point, go through the treatment.carbs and see if any of them are older than
        // the current BG data point.  If so, add those carbs to COB.
        var myCarbs = 0;
        //console.error(treatments.length);
        while(treatments.length>0) {
            treatment = treatments[treatments.length-1];

            if (treatment) {
                treatmentDate = new Date(tz(treatment.timestamp));
                treatmentTime = treatmentDate.getTime();
                //console.error("Got treatment, localtime= ",treatmentDate.toString().split(' ')[4]," carbs ",treatment.carbs);
                if ( treatmentTime <= BGTime ) {
                    if( treatment != null && treatment.hasOwnProperty("bolusCalc") == true  ) {
                        latestWizard = treatment.bolusCalc;
                        //if( treatment.bolusCalc.carbs >0 && CRInitialCarbTime == null  )
                        if( treatment.bolusCalc.carbs >0  ) {
                            wizardCarbsPending = treatment.bolusCalc.carbs;
                        }
                        if( treatment.bolusCalc.totalInsulin >0 ) {
                            wizardInsulinPending = treatment.bolusCalc.totalInsulin;
                            wizardInsulinIOB = iob;
                        }
                        if(debug_wizard) console.error( "Bolus Wizard entry at ", treatmentDate.toString().split(' ')[4], " wizardCarbsPending =",
                                        wizardCarbsPending," wizardInsulinPending =",
                                        wizardInsulinPending
                        );
                    }
                    if (treatment.carbs >= 1 && treatment.hasOwnProperty("duration")==false) {
                        /*if ( calculatingCR )
                            // most likely fast carbs
                            tempImpact = Math.max( profile.min_5m_carbimpact, tempImpact);
                            tempImpact += 5;
                            //console.error("tempImpact+",tempImpact);
                            var cob = mealCOB;
                            impactDecay.push(cob);
                         */
                        if (  opts.split_large_meals && treatment.carbs > 15 && calculatingCR && (wizardCarbsPending ==0 || wizardInsulinPending >0) ) {
                                var CREndIOB = prevIob;
                                var CREndBG = prevGlucoseDatum.glucose;
                                var CREndTime = new Date(prevGlucoseDatum.date);
                                console.error("CREndIOB:",CREndIOB,"CREndBG:",CREndBG,"CREndTime:",CREndTime);
                                prevGlucoseDatum.mealAbsorption = "end";
                                if(debug_categ)console.error(prevGlucoseDatum.mealAbsorption,"carb absorption");
                                CRCarbs -= mealCOB;
                                prevGlucoseDatum.mealCarbs = mealCOB;
                                mealCarbs = mealCOB;
                                var CRDatum = {
                                    CRInitialIOB: CRInitialIOB
                                ,   CRInitialIOBTime: CRInitialIOBTime == null ? CRInitialCarbTime : CRInitialIOBTime
                                ,   CRInitialBG: CRInitialBG
                                ,   CRInitialCarbTime: CRInitialCarbTime
                                ,   CREndIOB: CREndIOB
                                ,   CREndBG: CREndBG
                                ,   CREndTime: CREndTime
                                ,   CRCarbs: CRCarbs
                                ,   CRMinBG: CRMinBG
                                ,   CRMaxBG: CRMaxBG
                                };
                                if(latestWizard != null ) {
                                    var stapmp = latestWizard.timestamp;
                                    var wizardDate = new Date( stamp );
                                    console.error(wizardDate);
                                    if( wizardDate>= CRDatum.CRInitialIOBTime ) {
                                        CRDatum.bolusCalc = latestWizard;
                                    }
                                }
                                //console.error(CRDatum);

                                CRData.push(CRDatum);
                                CRCarbs  = mealCOB;
                                CRInitialIOB = iob;
                                CREndTime = null;
                                CRInitialCarbTime = new Date( glucoseDatum.date );
                                CRInitialIOBTime = CRInitialCarbTime;

                                calculatingCR = false;
                                type = "";
                        }
                        if ( treatment.carbs <= 15 && calculatingCR  && opts.fast_decay_le15g_carbs
                                && glucoseDatum.glucose <= 140
                            ) {
                            // most likely fast carbs
                            tempImpact = Math.max( profile.min_5m_carbimpact, tempImpact);
                            tempImpact += 5;
                            //console.error("tempImpact+",tempImpact);
                            var cob = {
                               time: BGTime,
                               cob:  mealCOB,
                               carbs: treatment.carbs
                            };
                            impactDecay.push(cob);
                        }
                        mealCOB += parseFloat(treatment.carbs);
                        mealCarbs += parseFloat(treatment.carbs);
                        myCarbs = treatment.carbs;
                        if ( myCarbs > 0 && savedI==0) {
                            var savedI = i;
                        }
                        if ( savedI > 0 ) {
                            savedMyCarbs += myCarbs;
                        }
                        if(debug_wizard) console.error("treatment.carbs=",treatment.carbs,"wizardCarbsPending",wizardCarbsPending);
                        if( treatment.carbs >= wizardCarbsPending ) {
                            wizardCarbsPending = 0;
                            if(debug_wizard)console.error("Pending carbs found",treatment.carbs);
                        }
                    }
                    if (treatment.carbs >= 1 && treatment.hasOwnProperty("duration")==true) {
                        extendedCarbsTill = treatmentTime+treatment.duration;
                    }
                    treatments.pop();
                } else {
                    break;
                }
            }
        }

        var BG;
        var delta;
        var avgDelta;
        function calcLongISF () {
            var long_dumb_isf = (BG - maxBG )/(-sumAct)*0.0555;
            if ( long_dumb_isf > 0 && sumAct > 0 )
                console.error("Long dumb isf " + Math.round( long_dumb_isf * 100)/100+ " maxBG "+ maxBG+ " longDelta " +( BG - maxBG )+ " sumAct " + sumAct + " sumLag " + sumLag) ;
            else if ( sumAct !== 0  && debug_categ )
                console.error("Something went wrong, long dumb isf is",long_dumb_isf," sumAct is ", sumAct);
            maxBG =0;
            sumAct =0;
            sumLag =0;
        }
        // TODO: re-implement interpolation to avoid issues here with gaps
        // calculate avgDelta as last 4 datapoints to better catch more rises after COB hits zero
        if (typeof(bucketedData[i].glucose) !== 'undefined' && typeof(bucketedData[i+4].glucose) !== 'undefined') {
            //console.error(bucketedData[i]);
            BG = bucketedData[i].glucose;
            if( CRCarbs > 0  ) {
                if( BG > CRMaxBG.val ) {
                    CRMaxBG.val = BG;
                    CRMaxBG.time = BGDate;
                }
                if( BG < CRMinBG.val &&
                    ((CRMinBG.time <= CRMaxBG.time ) || CRMaxBG.time == null || CRMaxBG.time <= CRInitialCarbTime) ||
                    CRMinBG.val == null ) {
                        CRMinBG.val = BG;
                        CRMinBG.time = BGDate;
                }
            }
            if ( BG < 40 || bucketedData[i+4].glucose < 40) {
                //process.stderr.write("!");
                continue;
            }
            delta = (BG - bucketedData[i+1].glucose);
            var longDelta = ( BG - bucketedData[i+4].glucose );
            var avgOldDelta = longDelta  /4;
            //avgDelta = avgOldDelta;
            //avgOldDelta = avgOldDelta.toFixed(2);
            var longLag = ( new Date( bucketedData[i].date ) - new Date(bucketedData[i+4].date) );
            avgDelta = longDelta  * 300000 / longLag;
            avgDelta = avgDelta.toFixed(2);
            //if( avgDelta != avgOldDelta ) {
            //    console.error("new lag",( new Date( bucketedData[i].date ) - new Date(bucketedData[i+4].date) ) );
            //    console.error("new avgDelta",avgDelta,"<>",avgOldDelta);
           // }
        } else {
            console.error("Could not find glucose data");
        }

        //avgDelta = avgDelta.toFixed(2);
        glucoseDatum.avgDelta = avgDelta;

        //sens = ISF
        var sens;
        [sens, lastIsfResult] = ISF.isfLookup(IOBInputs.profile.isfProfile, BGDate, lastIsfResult);
        IOBInputs.clock=BGDate.toISOString();
        // trim down IOBInputs.history to just the data for 6h prior to BGDate
        //console.error(IOBInputs.history[0].created_at);
        var newHistory = [];
        for (var h=0; h<fullHistory.length; h++) {
            var hDate = new Date(fullHistory[h].created_at)
            //console.error(fullHistory[i].created_at, hDate, BGDate, BGDate-hDate);
            //if (h == 0 || h == fullHistory.length - 1) {
                //console.error(hDate, BGDate, hDate-BGDate)
            //}
            if (BGDate-hDate <= (profileData.dia+1)*60*60*1000 && BGDate-hDate >= 0) {
                //process.stderr.write("i");
                //console.error(hDate);
                newHistory.push(fullHistory[h]);
            }
        }
        IOBInputs.history = newHistory;
        // process.stderr.write("" + newHistory.length + " ");
        //console.error(newHistory[0].created_at,newHistory[newHistory.length-1].created_at,newHistory.length);


        // for IOB calculations, use the average of the last 4 hours' basals to help convergence;
        // this helps since the basal this hour could be different from previous, especially if with autotune they start to diverge.
        // use the pumpbasalprofile to properly calculate IOB during periods where no temp basal is set
        var currentPumpBasal = basal.basalLookup(opts.pumpbasalprofile, BGDate);
        var BGDate1hAgo = new Date(BGTime-1*60*60*1000);
        var BGDate2hAgo = new Date(BGTime-2*60*60*1000);
        var BGDate3hAgo = new Date(BGTime-3*60*60*1000);
        var basal1hAgo = basal.basalLookup(opts.pumpbasalprofile, BGDate1hAgo);
        var basal2hAgo = basal.basalLookup(opts.pumpbasalprofile, BGDate2hAgo);
        var basal3hAgo = basal.basalLookup(opts.pumpbasalprofile, BGDate3hAgo);
        var sum = [currentPumpBasal,basal1hAgo,basal2hAgo,basal3hAgo].reduce(function(a, b) { return a + b; });
        IOBInputs.profile.currentBasal = Math.round((sum/4)*1000)/1000;

        // this is the current autotuned basal, used for everything else besides IOB calculations
        var currentBasal = basal.basalLookup(opts.basalprofile, BGDate);

        //console.error(currentBasal,basal1hAgo,basal2hAgo,basal3hAgo,IOBInputs.profile.currentBasal);
        // basalBGI is BGI of basal insulin activity.
        var basalBGI = Math.round(( currentBasal * sens / 60 * (lag/60000) )*100)/100; // U/hr * mg/dL/U * 1 hr / 60 minutes * 5 = mg/dL/5m
        //console.log(JSON.stringify(IOBInputs.profile));
        if(opts.dbg_output & 2) console.error("Get IOB getIOB(IOBInpus)[0]",IOBInputs.clock);
        // call iob since calculated elsewhere
        if( i == 0 && opts.dbg_output & 1 ) {
            IOBInputs.debug = true;
        }
        function starts(el) { return (el.mealAbsorption == "start"  ) }
        function ends(el) { return (el.mealAbsorption == "end"  ) }
        var mealEnds = CSFGlucoseData.filter(ends);
        var pairs = [];
        CSFGlucoseData.filter(starts).forEach(function(el) { var end = mealEnds.find( ( elm) => elm.date >= el.date ) ; if( typeof(end)==='undefined') end = glucoseDatum;  if (  end.date >= BGDate - profileData.dia*60*60*1000 ) pairs.push( [new Date(el.dateString),new Date(end.dateString) ]);});

        if(opts.dbg_output & 2) console.error("pairs ",pairs);
        if( pairs.length > 0 )  {
            IOBInputs.absorptionPeriods = pairs;
            if(opts.dbg_output & 2) console.error("IOBInputs.absorptionPeriods ",IOBInputs.absorptionPeriods);
        }
        var iob = getIOB(IOBInputs,true)[0];
        if( (opts.dbg_output & 1 && i == 0) || (opts.dbg_output & 2 ))  console.error(iob);

        var startTime = new Date(BGDate - profileData.dia*3600*1000);
        var endTime =  BGDate;
        var ztIOBInputs = {
            profile: profileData
        ,   history: [ {
                created_at: startTime.toISOString(),
                timestamp:  startTime.toISOString(),
                enteredBy: 'openaps://AndroidAPS',
                eventType: 'Temp Basal',
                isValid: true,
                duration:  Math.round((endTime.getTime()-startTime.getTime()) /60/1000),
                durationInMilliseconds: (endTime.getTime()-startTime.getTime() ),
                type: 'NORMAL',
                rate: 0,
                absolute: 0
            } ]
        , debug: opts.dbg_output & 3
        , split30: opts.split30
        ,   clock: endTime.toISOString()
        };
        var ztIob = getIOB(ztIOBInputs,true)[0];

        if (typeof(bucketedData[i].glucose) !== 'undefined' && typeof(bucketedData[i+4].glucose) !== 'undefined') {
            var longActivity = iob.activity+bucketedData[i+1].activity+bucketedData[i+2].activity+bucketedData[i+3].activity +bucketedData[i+4].activity;
        }

        if ( minBGDate != null && BGDate > new Date ( new Date( minBGDate.getTime() + 12*3600*1000 ).toDateString() )) {
            TDDBolusAct += iob.bolusActivity*lag/60000;
            TDDBasalAct += iob.basalActivity*lag/60000;

            if( delta < 0 ) {
                TDDDownAct += iob.activity*lag/60000;
                TDDDownDelta += delta;
            }
            if( delta == 0 ) {
                TDDZeroAct += iob.activity*lag/60000;
                TDDZeroDelta += delta;
            }
            if( delta > 0 ) {
                TDDUpAct += iob.activity*lag/60000;
                TDDUpDelta += delta;
            }
        }

        if( CRInitialIOB == null && mealCOB >0 ) {
            CRInitialIOB = iob;
        }
        if( wizardInsulinPending > 0  && Math.round((iob.bolusiob-wizardInsulinIOB.bolusiob) * 10 )/10 >= (wizardInsulinPending-0.1) ) {
            wizardInsulinPending = 0;
            if(debug_wizard) console.error("Pending insulin found: ", iob.bolusiob);
            if( calculatingCR  &&  opts.split_large_meals && wizardCarbsPending >= 15 ) {
                var CREndIOB = prevIob;
                var CREndBG = prevGlucoseDatum.glucose;
                var CREndTime = new Date(prevGlucoseDatum.date);
                prevGlucoseDatum.mealAbsorption = "end";
                if(debug_categ)console.error(prevGlucoseDatum.mealAbsorption,"carb absorption");
                //console.error("CREndIOB:",CREndIOB,"CREndBG:",CREndBG,"CREndTime:",CREndTime);
                CRCarbs -= mealCOB;
                prevGlucoseDatum.mealCarbs = mealCOB;
                mealCarbs = mealCOB;
                var CRDatum = {
                    CRInitialIOB: CRInitialIOB
                ,   CRInitialIOBTime: CRInitialIOBTime == null ? CRInitialCarbTime : CRInitialIOBTime
                ,   CRInitialBG: CRInitialBG
                ,   CRInitialCarbTime: CRInitialCarbTime
                ,   CREndIOB: CREndIOB
                ,   CREndBG: CREndBG
                ,   CREndTime: CREndTime
                ,   CRCarbs: CRCarbs
                ,   CRMinBG: CRMinBG
                ,   CRMaxBG: CRMaxBG
                };
                //console.error("iob: ", CRInitialIOB);
                CRData.push(CRDatum);
                CRCarbs = mealCOB;
                CREndTime = null;
                CRInitialCarbTime = null;

                calculatingCR = false;
                type = "";
            }
            CRInitialIOB=prevIob;
            CRInitialIOBTime=new Date( prevGlucoseDatum.date );
        }
        //console.error(JSON.stringify(iob));

        // activity times ISF times 5 minutes is BGI
        var BGI = Math.round(( -iob.activity * sens * (lag/60000) )*100)/100;
        var basBGI = Math.round(( -iob.basalActivity * sens * (lag/60000) )*100)/100;

        // datum = one glucose data point (being prepped to store in output)
        glucoseDatum.BGI = BGI;
        glucoseDatum.sens = sens;
        glucoseDatum.activity = iob.activity*(lag/60000);
        // calculating deviation
        var deviation = avgDelta-BGI;
        var dev5m = delta-BGI;
        //console.error(deviation,avgDelta,BG,bucketedData[i].glucose);

        // rounding and storing deviation
        deviation = deviation.toFixed(2);
        dev5m = dev5m.toFixed(2);
        glucoseDatum.deviation = deviation;
        //glucoseDatum.deviation = dev5m;

        var Gv = (glucoseDatum.glucose-prevGlucoseDatum.glucose)/(lag/60000);
        var prevGv =( bucketedData[i+1].glucose- bucketedData[i+2].glucose)/((bucketedData[i+1].date-bucketedData[i+2].date)/60000);
        var prevPrevGv =( bucketedData[i+2].glucose- bucketedData[i+3].glucose)/((bucketedData[i+2].date-bucketedData[i+3].date)/60000);
        glucoseDatum.Gv = Gv;
        //console.error( "Gv = ", Gv, "prevGV = ", prevGv);
        var sdg = (Gv-prevGv)/(lag/60000);
        var prevSdg =  (prevGv - prevPrevGv ) / ((bucketedData[i+1].date-bucketedData[i+2].date)/60000);

        GDinPISA= Math.min( GinPISA, BGI/5*Gratio);
        GDinPISA= Math.min( GDinPISA, glucoseDatum.glucose > 120 ? -1.9 : GDinPISA );
        if( opt_PISA ) {
            if( !PISA && (Gv <= GDinPISA)   ) {
                var r1PISA = Gv / prevGv;
                console.error("Pre-PISA Gv ", Gv, "r1PISA",  r1PISA, "sdg",sdg," prevSdg",prevSdg, "GDinPISA",GDinPISA);
                if( r1PISA > Gratio  ||  ( ( sdg > 0 ) && ( prevSdg <= 0 ) ||  prevGv > 0 ) ) {
                    console.error( "In PISA",r1PISA,Gratio,prevGv);
                    PISA = true;;
                    iPISA = i;
                    GvIN= Gv;
                    need_uptick = false;
                    uptick = false;
                }
            }
            if(!PISA) {
               iPISA = 0;
               GvIN = 0;
            }
            if(PISA && Gv*5 >= Math.floor(-GvIN*4) ) {
                uptick = true;
            }
            if(iPISA-i >= 3) {
                if( bucketedData[i].glucose - bucketedData[iPISA].glucose <= -1.6*5*(iPISA-i)) {
                    need_uptick=true;
                    console.error("need uptick",bucketedData[iPISA].glucose,bucketedData[i].glucose, -1.6*5*(iPISA-i) );
                }

                var i1_3rd=Math.round(iPISA-(iPISA-i)/3);
                var i2_3rd=Math.round(iPISA-2*(iPISA-i)/3);
                var Gv13 = (bucketedData[i1_3rd].glucose - bucketedData[iPISA].glucose)/((bucketedData[i1_3rd].date - bucketedData[iPISA].date)/60000);
                var Gv23 = (bucketedData[i2_3rd].glucose - bucketedData[i1_3rd].glucose)/((bucketedData[i2_3rd].date - bucketedData[i1_3rd].date)/60000)
                var Gv33 = (bucketedData[i].glucose - bucketedData[i2_3rd].glucose)/((bucketedData[i].date - bucketedData[i2_3rd].date)/60000)
                //console.error(iPISA,i1_3rd,i,"gv13 = ",Gv13 );
                //console.error(iPISA,i2_3rd,i,"gv23 = ",Gv23 );
                //console.error(iPISA,i2_3rd,i,"gv33 = ",Gv33 );
                var sdg23=(Gv23-Gv13)/((bucketedData[i2_3rd].date-bucketedData[i1_3rd].date)/60000)
                var sdg33=(Gv33-Gv23)/((bucketedData[i].date- bucketedData[i2_3rd].date)/60000)
            }
            if(PISA && ((glucoseDatum.date - bucketedData[iPISA].date)/60000 > tPISAmax ) ) {
                console.error("Out PISA tPISAmax",(glucoseDatum.date - bucketedData[iPISA].date)/60000 );
                PISA = false;
                iPISA = 0;
            }
            if(PISA && lagMinutes >= tPISAdropout ) {
                console.error("Out PISA tPISAdropout",lagMinutes );
                PISA = false;
                iPISA = 0;
            }
            //console.error("GvIN",GvIN,"Gv",Gv);
            if(PISA && Gv > GoutPISA ) {
                if( (glucoseDatum.smoothed < glucoseDatum.glucose) && ( (glucoseDatum.glucose - glucoseDatum.smoothed) > Math.abs(GinPISA)*3 ) && (uptick && ! (Gv*5 >= Math.floor(-GvIN*4)) && need_uptick || !need_uptick )) {
                    console.error("Out PISA smoothing", glucoseDatum.smoothed, glucoseDatum.glucose );
                    PISA = false;
                    iPISA = 0;
                }
                //console.error(iPISA-i,"Second derivative of glucose by time for i="+i," dg/dt = ",sdg );
                //console.error(iPISA-i,"Second derivative of glucose by time for i="+(i+1)," dg/dt = ",prevSdg );
                if( PISA && (iPISA-i>=3) && ( sdg < 0 ) && ( prevSdg < 0 )  && (uptick && !( Gv*5 >= Math.floor(-GvIN*4)) && need_uptick || !need_uptick) ){
                    //console.error("Out PISA f2 ", prevSdg,sdg );
                    console.error("Out PISA f2 ", sdg,prevSdg );
                    PISA = false;
                    iPISA = 0;
                }
                var R31 = bucketedData[i+3].Gv / bucketedData[i+1].Gv;
                var R30 = bucketedData[i+3].Gv / bucketedData[i].Gv;
                if( PISA && (  GratioMin <= R31  ) && ( R31 <= GratioMax) &&  (  GratioMin <= R30  ) && ( R30 <= GratioMax) ) {
                    console.error("Out PISA f3 ", R31,R30 );
                    PISA = false;
                    iPISA = 0;
                }
                var R41 = bucketedData[i+3].Gv / bucketedData[i+1].Gv;
                var R40 = bucketedData[i+3].Gv / bucketedData[i].Gv;
                if(  PISA &&  (  GratioMin <= R41  ) && ( R41 <= GratioMax) &&  (  GratioMin <= R40  ) && ( R40 <= GratioMax)) {
                        console.error("Out PISA f4",R41,R40);
                        PISA = false;
                        iPISA = 0;
                }
            }
        }


        if ( !absorbing && mealCOB > 0 ) {
            if ( dev5m > Math.min(4*basalBGI ,profile.min_5m_carbimpact ) ){
                if(debug_categ)console.error('Started delayed absorbtion due to deviations ',dev5m,'4*basalBGI',4*basalBGI,'min_5m_carbimpact',profile.min_5m_carbimpact);
                absorbing = 1;
            } else if ( i<=savedI-4 ) {
                if(debug_categ)console.error('Started delayed absorbtion due to max delay of 4*5min intervals');
                absorbing = 1;
            } else if ( !opts.delay_meal_absorption ) {
                absorbing = 1;
            }
        }

        // Then, calculate carb absorption for that 5m interval using the deviation.
        if ( mealCOB >= 0 && absorbing ) {
            var minImpact = Math.max(profile.min_5m_carbimpact, tempImpact );
            var ci = Math.max(deviation, minImpact );
            //if ( ci != deviation ) {
            //    console.error("using ",minImpact," instead of avgDev",deviation);
            //}
            var dt = new Date( BGTime );
            var carb_ratio = Carbs.crLookup(profile, dt);
            //console.error("BGTime",BGTime," ratio ", carb_ratio );
            var absorbed = ci * carb_ratio / sens;
            //console.error("Carb impact", ci,"sens",sens,"absorbed",absorbed);
            // Store the COB, and use it as the starting point for the next data point.
            mealCOB = Math.max(0, mealCOB-absorbed);
            if(CRInitialCarbTime != null  && BGTime-CRInitialCarbTime >= 4.5*3600*1000 &&
                BGTime-CRInitialCarbTime <= 4.5*3600*1000+900*1000 ) {
                if( impactDecay.length == 0 ) {
                    mealCOB = 0;
                } else {
                    mealCOB -= impactDecay[impactDecay.length-1].cob;
                }
            }
            if( impactDecay.length && mealCOB <= impactDecay[impactDecay.length-1].cob ) {
                tempImpact -= 15;
                //console.error("tempImpact-", tempImpact ," cob < ", impactDecay[impactDecay.length-1]);
                impactDecay.pop();
            }
        }
        // set positive deviations to zero if BG is below 80
        if ( BG < 80 && deviation > 0 ) {
            glucoseDatum.realDeviation = deviation;
         //   deviation = (0).toFixed(2);
        }



        // Calculate carb ratio (CR) independently of CSF and ISF
        // Use the time period from meal bolus/carbs until COB is zero and IOB is < currentBasal/2
        // For now, if another meal IOB/COB stacks on top of it, consider them together
        // Compare beginning and ending BGs, and calculate how much more/less insulin is needed to neutralize
        // Use entered carbs vs. starting IOB + delivered insulin + needed-at-end insulin to directly calculate CR.

        //if (mealCOB > 0 && absorbing || calculatingCR || savedI>0 && savedI >= i+4) {
        if (mealCOB > 0 && absorbing || calculatingCR ) {
            CRCarbs += savedMyCarbs;
            savedMyCarbs = 0;
            savedI = 0;
            // set initial values when we first see COB
            if (!calculatingCR) {
                if( prevGlucoseDatum.mealAbsorption != "end" && prevIob.iob >= iob.iob ) {
                    if( CRInitialIOB == null ) {
                        CRInitialIOB = prevIob;
                    }
                    CRInitialBG = prevGlucoseDatum.glucose;
                    CRInitialCarbTime = new Date(prevGlucoseDatum.date);
                } else {
                    if( CRInitialIOB == null ) {
                        CRInitialIOB = iob;
                    }
                    CRInitialBG = glucoseDatum.glucose;
                    CRInitialCarbTime = new Date(glucoseDatum.date);
                }
                //if( wizardCarbsPending == treatment.carbs ) {
                 //   wizardCarbsPending = 0;
                  //  console.error("Pending carbs found",CRCarbs);
                //}
                //console.error("CRInitialIOB:",CRInitialIOB,"CRInitialBG:",CRInitialBG,"CRInitialCarbTime:",CRInitialCarbTime);
            }
            // if meal IOB has decayed, then end absorption after this data point unless COB > 0
            //console.error("currentBasal",currentBasal);
            if ( mealCOB == 0 && absorbing  && impactDecay.length == 0
                    &&  (iob.activity < -ztIob.basalActivity/2) && deviation <=0.25
                    && (
                        (Math.abs(iob.mealBasalActivityCorrection) < Math.abs(iob.basalActivity))
                        || (BGTime-CRInitialCarbTime>=3600*1000*CRCarbs/10) && limit_decay_time
                    )
                 ) {
                absorbing = 0;
                if(  (BGTime-CRInitialCarbTime>=3600*1000*CRCarbs/10 ) && limit_decay_time) {
                   console.error("deltaT=",(BGTime-CRInitialCarbTime)/1000);
                   glucoseDatum.mealAbsorption = "end";
                }
            // otherwise, as long as deviations are positive, keep tracking carb deviations
            //} else if ( mealCOB == 0 && absorbing && deviation <= 3.0 ) {
            } else if ( mealCOB == 0 && absorbing && (deviation <= end_meal_avgdev || (BG <= CRInitialBG && opts.limit_decay_time))) {
                absorbing = 0;
            }
            // keep calculatingCR as long as we have COB or enough IOB
            if ( mealCOB > 0 && i>1 ) {
                calculatingCR = true;
            } else if ( absorbing ) {
                calculatingCR = true;
            // when COB=0 and IOB drops low enough, record end values and be done calculatingCR
            } else {
                var CREndIOB = iob;
                var CREndBG = glucoseDatum.glucose;
                var CREndTime = new Date(glucoseDatum.date);
                //console.error("CREndIOB:",CREndIOB,"CREndBG:",CREndBG,"CREndTime:",CREndTime);
                var CRDatum = {
                    CRInitialIOB: CRInitialIOB
                ,   CRInitialIOBTime: CRInitialIOBTime == null ? CRInitialCarbTime : CRInitialIOBTime
                ,   CRInitialBG: CRInitialBG
                ,   CRInitialCarbTime: CRInitialCarbTime
                ,   CREndIOB: CREndIOB
                ,   CREndBG: CREndBG
                ,   CREndTime: CREndTime
                ,   CRCarbs: CRCarbs
                ,   CRMinBG: CRMinBG
                ,   CRMaxBG: CRMaxBG
                };
                //console.error(CRDatum);

                var CRElapsedMinutes = Math.round((CREndTime - CRInitialCarbTime) / 1000 / 60);
                //console.error(CREndTime - CRInitialCarbTime, CRElapsedMinutes);
//                if ( CRElapsedMinutes < 60 || ( i===1 && mealCOB > 0 ) || !CRDatum.CRInitialIOB ) {
                if ( CRElapsedMinutes < 60 || ( i===1 && mealCOB > 0 ) || !CRDatum.CRInitialIOB || CRDatum.CRCarbs <= 15) {
                    console.error("Ignoring",CRElapsedMinutes,"m CR period. (i=",i,",mealCOB=",mealCOB,")");
                } else {
                    if(latestWizard != null ) {
                        var stamp = latestWizard.timestamp;
                        var wizardDate = new Date( stamp );
                        if( wizardDate>= CRDatum.CRInitialIOBTime ) {
                            CRDatum.bolusCalc = latestWizard;
                        }
                    }
                    myCarbs=0;
                    CRData.push(CRDatum);
                }

                CRCarbs = 0;
                CREndTime = null;
                CRInitialCarbTime = null;
                CRInitialIOB = null;
                CRInitialIOBTime = null;
                calculatingCR = false;
            }
        }


        // If mealCOB is zero but all deviations since hitting COB=0 are positive, assign those data points to CSFGlucoseData
        // Once deviations go negative for at least one data point after COB=0, we can use the rest of the data to tune ISF or basals
        if ( ! absorbing && ! (mealCOB > 0 ) ) {
            mealCarbs = 0;
            glucoseDatum.mealCarbs = mealCarbs;
        }
        //if (mealCOB > 0 || absorbing || mealCarbs > 0) {
        if (  absorbing && ( mealCOB > 0 ||  mealCarbs > 0) ) {
            // check previous "type" value, and if it wasn't csf, set a mealAbsorption start flag
            //console.error(type);
            if ( absorbing ) {
                if ( type !== "csf" ) {
                    uam = 0;
                    glucoseDatum.mealAbsorption = "start";
                    if(debug_categ)console.error(glucoseDatum.mealAbsorption,"carb absorption");
                    calcLongISF();
                }
                type="csf";
                // geting rid of up to 6 UAM readings right before the meal ( early bolus, etc ) lest to contaminate basal data
                var ual = UAMGlucoseData.length;
                for( var iter = UAMGlucoseData.length-1; iter>=0; --iter){
                    if( UAMGlucoseData[iter].date >= glucoseDatum.date - 60*1000*5*(ual - iter) - 60*1000*5  && ual - iter <= 6 ){
                        //console.error(new Date(UAMGlucoseData[iter].date).toString().split(" ")[4]);
                        UAMGlucoseData.pop();
                    } else {
                        break;
                    }
                }
            }
            glucoseDatum.mealCarbs = mealCarbs;
            //if (i == 0) { glucoseDatum.mealAbsorption = "end"; }
            CSFGlucoseData.push(glucoseDatum);
        } else {
          // check previous "type" value, and if it was csf, set a mealAbsorption end flag
          if ( type === "csf" ) {
            CSFGlucoseData[CSFGlucoseData.length-1].mealAbsorption = "end";
            CSFGlucoseData[CSFGlucoseData.length-1].mealCarbs = 0;
            if(debug_categ) console.error(CSFGlucoseData[CSFGlucoseData.length-1].mealAbsorption,"carb absorption");
          }
          {
            var splitCombined = function (glucoseDatum ) {
                var bolusActivity = iob.bolusActivity;
                var basalActivity = iob.basalActivity;
                var ztDIABasalAct = ztIob.basalActivity;
                var corr = Math.abs(iob.mealBasalActivityCorrection);
                var posBasAct = iob.mealBasalActivityCorrection < 0? ztDIABasalAct-iob.mealBasalActivityCorrection : ztDIABasalAct/4;
                if(debug_categ) {
                    console.error("   iob.activity "+iob.activity +" bolusActivity "+bolusActivity
                        +" basalActivity "+iob.basalActivity
                        +" ztDIABasalAct "+ ztDIABasalAct
                        + " Correction "+ iob.mealBasalActivityCorrection
                        + " PosBasAct" + posBasAct
                    );

                }
                if(1){
                    bolusActivity += iob.mealBasalActivityCorrection;
                    basalActivity -= iob.mealBasalActivityCorrection;
                    var corrActivity = iob.activity;
                    if(basalActivity != iob.basalActivity ) {
                        corrActivity = Math.round((bolusActivity+basalActivity) * 100000)/100000;
                    }
                    if(debug_categ)console.error( '   corrActivity '+corrActivity +' bolusActivity ' +Math.round(bolusActivity *100000)/100000+' basalActivity '+ Math.round(basalActivity *100000)/100000 );
                }
                var R1 = (Math.abs(basalActivity)+Math.abs(iob.mealBasalActivityCorrection))/(Math.abs(bolusActivity)+Math.abs(basalActivity)+Math.abs(iob.mealBasalActivityCorrection));
                var R3 = (Math.abs(basalActivity))/(Math.abs(bolusActivity)+Math.abs(basalActivity)+Math.abs(iob.mealBasalActivityCorrection))
                var R2 = 1 - R3;
                if ( R3 != R1 ) R1 = R3;

                var corrBGI = Math.round(( -corrActivity * sens * (lag/60000) )*100)/100;
                var corrBasBGI = Math.round(( -basalActivity * sens * (lag/60000) )*100)/100;
                var corrBolBGI = Math.round(( -bolusActivity * sens * (lag/60000) )*100)/100;
                var ztBasalBGI = Math.round(( -ztIob.basalActivity * sens * (lag/60000) )*100)/100;
                var realBasBGI = Math.round(( posBasAct * sens * ( lag/60000))*100)/100;
                if(corrBGI != glucoseDatum.BGI ) {
                    BGI = corrBGI;
                }
                if(corrBasBGI != basBGI ) {
                    //if(debug_categ) console.error("corrBasBGI "+corrBasBGI+" basBGI "+basBGI);
                    basBGI = corrBasBGI;
                }
                if(debug_categ) {
                    console.error(
                          "            BGI " + glucoseDatum.BGI
                        + "          bolBGI " +corrBolBGI
                        + "          basBGI "+ basBGI
                        + "      ztBasalBGI " + ztBasalBGI + " basalBGI "+basalBGI
                        + " sens " + sens + " lag " + lag + " realBasBGI "+realBasBGI
                    )
                }
                if(debug_categ)console.error(
                    '   R1 '+Math.round((1-R2)*100000)/100000+
                    '   R2 '+Math.round(R2*100000)/100000+
                    '   R3 '+Math.round(R3*100000)/100000
                )
                var bas = _.cloneDeep(glucoseDatum);
                var isf = _.cloneDeep(glucoseDatum);
                var dev = glucoseDatum.deviation;
                var BGI = glucoseDatum.BGI;
                //bas.deviation = avgDelta*R1 - basBGI ;
                bas.origBGI = corrBGI;
                bas.basBGI = corrBasBGI;
                bas.basalBGI = basalBGI;
                bas.origDeviation = dev;
                // BGI = ( bolusBGI + basBGI )
                var res = 0;
                var pessimisticDev = avgDelta -  BGI - realBasBGI;
                var maxBGI =  BGI + realBasBGI;
                var optimisticDev = avgDelta -  BGI;
                var minBGI =  BGI;
                if( basBGI > 0 ) {
                    bas.deviation =  avgDelta >0 ? avgDelta - basBGI  : avgDelta - BGI;
                    bas.BGI = avgDelta > 0? basBGI : BGI;
                } else {
                    bas.deviation = (avgDelta - BGI)*R1 ;
                    bas.BGI = BGI*R1;
                }

                var k111 = 1-Math.abs(corrActivity)/(Math.abs(corrActivity)+Math.abs(posBasAct));
                if(basBGI > 0 )
                    var k111 = 1-k111;

                if(debug_categ)console.error("   bas.deviation "+bas.deviation+" basBGI "+bas.BGI);
                if( !PISA && bas.deviation <= 6 &&
                    (
                       corrActivity*4 < -ztDIABasalAct  ||
                       (avgDelta  >0 || basBGI > 0 ) && (corr*8 <= -ztDIABasalAct)
                    )
                ) {
                    if(debug_categ) { console.error("   unusual basal BGI:"+Math.round(bas.BGI *100)/100+" dev "+Math.round(bas.deviation *10000)/10000+" R "+Math.round(R1 * 100000)/100000); }
                    type="basal";
                    res = 1;
                    basalGlucoseData.push(bas)
                };
                isf.origBGI = BGI;
                isf.basBGI = basBGI;
                isf.basalBGI = basalBGI;
                isf.origDeviation = dev;

                isf.deviation = pessimisticDev*(1-k111)+optimisticDev*k111;
                isf.BGI = maxBGI*(1-k111)+minBGI*k111;;

                var a_max = profileData.autosens_max+0.1;
                var a_min = profileData.autosens_min-0.1;
                if ( (avgDelta <= 0 || 3/4*Math.abs(corrActivity) >= Math.abs(ztDIABasalAct)/4 )&& lag <= 10*60*1000 ) {
                    var isf_val = (1+isf.deviation/isf.BGI) * sens;;
                    var dumb_isf = avgDelta/(-corrActivity*(lag/60000))*0.0555;
                    var dumb4_isf = longDelta/(-longActivity)*0.0555;
                    if(prevGlucoseDatum.glucose > maxBG  && corrActivity > 0 & avgDelta <0) {
                        maxBG = prevGlucoseDatum.glucose;
                        sumAct = 0;
                        sumLag = 0;
                        console.error( '   maxBG '+maxBG+' sumAct '+sumAct+' sumLag '+sumLag);
                    }
                    sumAct += corrActivity*lag/60000;
                    sumLag += lag/1000;
                }

                if( avgDelta > 0 ||  corrActivity >0 && delta >0  ){
                    if(maxBG > 0)calcLongISF();
                    maxBG = 0;
                    sumAct = 0;
                    sumLag = 0;
                }
                var isf_out_of_bounds = false;

                if(debug_categ) {
                    console.error("    k1=",k111," pD ",pessimisticDev," maxBGI",maxBGI," oD ",optimisticDev,
                        " i ",minBGI," d ",isf.deviation," I " , isf.BGI
                    );
                    console.error("   supposed isf val "+Math.round(isf_val * 100 )/100+
                        '('+Math.round(isf_val*.0555*100)/100 + ") dev "+Math.round(isf.deviation *10000)/10000+
                        "BGI"+Math.round(isf.BGI *100)/100+" R "+Math.round(R2*10000)/10000+" > "+
                        (Math.abs(corrActivity) >= Math.abs(ztDIABasalAct)/4) +
                        " Dumb isf " + Math.round( dumb_isf *100)/100+" isf4 "+Math.round( dumb4_isf *100)/100
                    );
                    if( !(isf_val <= sens / a_min && isf_val >= sens / a_max ))
                        console.error("   isf is out of bounds ",isf_val, sens/a_max, sens/a_min );
                }
                if( !(isf_val <= sens / a_min && isf_val >= sens / a_max ))
                        isf_out_of_bounds = true;
                if( ( !PISA || PISA && !isf_out_of_bounds) &&
                    isf.deviation <= 6 &&
                    3/4*corrActivity >= Math.abs(ztDIABasalAct)/4 &&
                    ((corr >0  && basBGI >0) || (basBGI <= 0))
                    && isf_val > 0
                ) {
                    if(debug_categ) { console.error("   unusual isf BGI:"+isf.BGI+" dev "+isf.deviation+" R "+R2); }
                    type = "ISF";
                    res = 1;
                    ISFGlucoseData.push(isf)
                };
                if(!res) type = "---";
            }

          }
          if ((iob.iob > 2 * currentBasal || deviation > 6 || uam) && (wizardCarbsPending == 0 || wizardCarbsPending >0 && type != "ISF") ) {
            if (deviation > 0 && avgDelta > 0  && type === "uam") {
                uam = 1;
            } else {
                uam = 0;
            }
            if ( type !== "uam" && !( opts.combined_isf_basal && opts.categorize_uam_as_basal && wizardCarbsPending == 0 && avgDelta <= 0)) {
                glucoseDatum.uamAbsorption = "start";
                calcLongISF();
                if(debug_categ) {
                    console.error(glucoseDatum.uamAbsorption,"unannounced meal absorption iob ",iob.iob," deviation ", deviation, " uam ", uam, " cb " , currentBasal);
                }
                type="uam";
            }
            if(  opts.combined_isf_basal && opts.categorize_uam_as_basal && wizardCarbsPending == 0 && avgDelta <= 0) {
                splitCombined(glucoseDatum);
            } else {
                if(debug_categ) {
                    console.error("opts.combined_isf_basal=",opts.combined_isf_basal);
                    console.error("opts.categorize_uam_as_basal=",opts.categorize_uam_as_basal);
                    console.error("wizardCarbsPending=",wizardCarbsPending);
                }
                UAMGlucoseData.push(glucoseDatum);
            }
          } else {
            if ( type === "uam" ) {
                uam = 0;
                glucoseDatum.uamAbsorption = "end";
                if(debug_categ) {console.error("end unannounced meal absorption");}
            }


            // Go through the remaining time periods and divide them into periods where scheduled basal insulin activity dominates. This would be determined by calculating the BG impact of scheduled basal insulin (for example 1U/hr * 48 mg/dL/U ISF = 48 mg/dL/hr = 5 mg/dL/5m), and comparing that to BGI from bolus and net basal insulin activity.
            // When BGI is positive (insulin activity is negative), we want to use that data to tune basals
            // When BGI is smaller than about 1/4 of basalBGI, we want to use that data to tune basals
            // When BGI is negative and more than about 1/4 of basalBGI, we can use that data to tune ISF,
            // unless avgDelta is positive: then that's some sort of unexplained rise we don't want to use for ISF, so that means basals
            if ((basalBGI > -4 * BGI ) && ( BGI <= 0 )  || BGI > 0 || iob.bolusiob == 0) {
                type="basal";
            } else {
                if (  (avgDelta >= 0)  && ( BGI < 0 ) && ( iob.iob >= 0 ) ) {
                //if ( avgDelta > 0  ) \leftBrace
                    //type="unknown"
                    type="basal"
                } else if ( BGTime >= extendedCarbsTill ) {
                /// else \leftBrace
                    if( type != "ISF" ) {
                        /* if(debug_categ) {console.error("start ISF interval");}
                        intervalDataISF = {
                            startTime: new Date(prevGlucoseDatum.date),
                            dosed: 0,
                            startBG: prevGlucoseDatum.glucose,
                            startIOB: iob
                        }; */
                    }
                    type="ISF";
                }
            }
            if( (type == "basal" || type == "ISF" )  &&  opts.combined_isf_basal) {
                splitCombined(glucoseDatum);
            } else {
                if(debug_categ) {console.error("old scheme ( usual )");}
                if( type == "basal" && !PISA) {
                    basalGlucoseData.push(glucoseDatum);
                } else if ( type == "ISF" && !PISA) {
                    ISFGlucoseData.push(glucoseDatum);
                }
            }
          }
        }
        if( intervalDataISF != null && type != "ISF" ) {
            //if(debug_categ) {console.error("stop ISF interval");}
            intervalDataISF = null;
        }
        // debug line to print out all the things
        var BGDateArray = BGDate.toString().split(" ");
        BGTime = BGDateArray[4];
        if(typeof(ci) == 'undefined') {
            ci = 0;
        }
        // console.error(absorbing.toString(),"mealCOB:",mealCOB.toFixed(1),"mealCarbs:",mealCarbs,"basalBGI:",basalBGI.toFixed(1),"BGI:",BGI.toFixed(1),"IOB:",iob.iob.toFixed(1),"at",BGTime,"dev:",deviation,"avgDelta:",avgDelta,type);
        var absorptionIndicator= absorbing && mealCOB>0? (-1*absorbed).toFixed(1).padStart(4,' ') : '    ';
        var BGImmol = (Math.abs(Math.round(BGI*MGDL2MMOL*100)/100)).toFixed(2).padStart(4,' ');
        var BGmmol = Math.round(BG*MGDL2MMOL*10)/10;
        var BGstr = (BG.toString() + "|" + BGmmol.toFixed(1).padStart(4,' ')).padStart(8,' ');
        var insulinDosed = 0;
        var CR = 0;
        var TI = 0;
        if( type.substring(0,3) == "csf" && CRInitialCarbTime >0) {
            var tmp_treatments = find_insulin(IOBInputs);
            var dosedOpts = {
                treatments: tmp_treatments
                , profile: opts.profile
                , start: CRInitialIOBTime != null ? CRInitialIOBTime : CRInitialCarbTime
                , end: BGDate
            };
            insulinDosed = dosed(dosedOpts);
            var dose = 0;
            if(opts.dosed_bolus_only){
                dose = insulinDosed.bolus;
            } else {
                dose = insulinDosed.insulin;
                //console.error("dosed basal:",insulinDosed.basal,"iob.netBasalInsulin:",iob.netbasalinsulin);
            }
            if(CRInitialIOB != null) {
                TI =    CRInitialIOB.iob-iob.iob +dose+(BG-CRInitialBG)/sens ;
            }
            if( TI != 0 ) {
                var carbs = (mealCarbs ? mealCarbs : CRDatum.CRCarbs) - mealCOB;
                CR = ( Math.round( carbs/TI *10 )/10 ).toFixed(1);
            }
        }
        if( minBGDate == null ) {
            minBGDate = BGDate;
            //console.error("minBGDate = ", minBGDate );
        }
        if( type.substring(0,3) == "ISF"  || type.substring(0,3)=='---' ) { //: was && intervalDataISF != null
            var ratios = [];
            var ratI;
            for (ratI=0; ratI < ISFGlucoseData.length; ++ratI) {
                        if (new Date( ISFGlucoseData[ratI].date ) < new Date ( new Date( minBGDate.getTime() + 12*3600*1000 ).toDateString() )){
                    if(debug_categ)console.error("skipping ISF dated "+ new Date( ISFGlucoseData[ratI].date) );
                    continue;
                    }
                var ratio = 1 + ISFGlucoseData[ratI].deviation / ISFGlucoseData[ratI].BGI;
                if(debug_ratios)console.error("ratios"+ratI+" "+ratio );
                ratios.push(ratio);
            }
            ratios.sort(function(a, b){return a-b});
            var p50ratios = percentile( ratios, 0.50);
            //console.error("p50 ratios"+p50ratios );
            TI += glucoseDatum.activity;
            if( isNaN( p50ratios ) ) {
               console.error("p50 ratios"+p50ratios );
                       console.error("p50 ratios arr:",ratios );
            }
            CR = Math.round( percentile( ratios, 0.50 )  * sens  *.0555 * 10 )/10;
        }
        if( i == 0 ) calcLongISF();
        console.error(
            //(bucketedData.length-i) + " " +
            BGTime+' '+
            BGstr+" δ"+delta.toString().padStart(3,' ')+" ∆"+avgDelta.padStart(6,' ')+
            " BGI"+BGI.toFixed(1).padStart(5,' ')+"|"+BGImmol+'/'+iob.activity.toFixed(4).padStart(7,' '),
            "σ"+dev5m.padStart(6,' ')+" ∆σ"+deviation.padStart(6,' ')+(absorbing && ci != deviation? '>'+ci : '').padEnd(3,' ')+
            " COB"+absorptionIndicator+(mealCOB.toFixed(1)+"/"+mealCarbs.toFixed(0).padStart(2,' ')).padStart(9,' ')+
            " IOB"+iob.iob.toFixed(3).padStart(6,' ')+"="+iob.bolusiob.toFixed(3).padStart(6,' ')+( iob.basaliob < 0 ? "-" : "+" ) +Math.abs(iob.basaliob).toFixed(3).padStart(6,' '),
            type.substring(0,3), myCarbs.toFixed(0).padStart(2,' '), TI.toFixed(3),CR
        );
        if ( CRCarbs == 0 || CRInitialCarbTime != null && CRInitialCarbTime.getTime() == glucoseDatum.date) {
            CRMaxBG = {
                val: 0,
                time: null
            };
            CRMinBG = {
                val: null,
                time: null
            };
        }
        if ( CRInitialBG != null && BG <= CRInitialBG &&  mealCOB == 0 && !calculatingCR && CRData.length > 0 ) {
            var startTime =  CRData[CRData.length-1].CRInitialIOBTime.getTime();
            var endTime =  CRData[CRData.length-1].CREndTime.getTime();
            //console.error('there we go again',glucoseDatum.date,startTime, profileData.dia*3600*1000);
            if( glucoseDatum.date <= (startTime + profileData.dia*3600*1000) && glucoseDatum.date != endTime) {
                CRData[CRData.length-1].alternative = {
                    iob: iob,
                    endTime: new Date( glucoseDatum.date ),
                    bg: BG
                };
                CRInitialBG = null;
            } else {
                CRInitialBG = null;
            }
        }
    }

    IOBInputs = {
        profile: profileData
    ,   history: opts.pumpHistory
    ,   clock: null
    };
    CRData.forEach(function(CRDatum) {
        IOBInputs.clock= ("alternative" in CRDatum ) ? CRDatum.alternative.endTime : CRDatum.CREndTime.toISOString();
        var savedDia = opts.profile.dia;
        var newDia = profileData.dia+Math.ceil( (  new Date ( IOBInputs.clock )-( CRDatum.CRInitialIOBTime== null ? CRDatum.CRInitialCarbTime : CRDatum.CRInitialIOBTime))/(3600*1000));
        profileData.dia = newDia;
        if(debug_meal_dosed)console.error("meals loop iobinputs clock",IOBInputs.clock);
        treatments = find_insulin(IOBInputs);
        if(debug_meal_dosed)console.error("meals loop pre-dosed dia",profileData.dia);
        var dosedOpts = {
            treatments: treatments
            , profile: profileData
            , start: CRDatum.CRInitialIOBTime== null ? CRDatum.CRInitialCarbTime : CRDatum.CRInitialIOBTime
            , end: CRDatum.CREndTime
            , debug: debug_meal_dosed ? true : false
        };
        var insulinDosed = dosed(dosedOpts);
        profileData.dia = savedDia;
        if(debug_meal_dosed)console.error("meals loop post-dosed dia",profileData.dia);
        dose = 0;
        if(opts.dosed_bolus_only){
            dose = insulinDosed.bolus;
        } else {
            dose = insulinDosed.insulin;
        }
        CRDatum.CRInsulin = dose;
        CRDatum.dosed  = insulinDosed;
        if(debug_meal_dosed)console.error("dosed = ",dose, insulinDosed);
        if(debug_meal_dosed)console.error(CRDatum);
        if("alternative" in CRDatum ) {
            var dosedOpts = {
                treatments: treatments
                , profile: opts.profile
                , start: CRDatum.CRInitialIOBTime== null ? CRDatum.CRInitialCarbTime : CRDatum.CRInitialIOBTime
            , end: CRDatum.alternative.endTime
            };
            CRDatum.alternative.dosed = dosed(dosedOpts);
        }
        var startTime = CRDatum.CRInitialIOBTime == null ? CRDatum.CRInitialCarbTime : CRDatum.CRInitialIOBTime;
        var endTime = ("alternative" in CRDatum ) ? CRDatum.alternative.endTime : CRDatum.CREndTime;
        var fakeIOBInputs = {
            profile: profileData
        ,   history: [ {
                created_at: startTime.toISOString(),
                timestamp:  startTime.toISOString(),
                enteredBy: 'openaps://AndroidAPS',
                eventType: 'Temp Basal',
                isValid: true,
                duration:  Math.round((endTime.getTime()-startTime.getTime()) /60/1000),
                durationInMilliseconds: endTime.getTime()-startTime.getTime(),
                type: 'NORMAL',
                rate: 0,
                absolute: 0
            } ]
        ,   clock: endTime.toISOString()
        };
        var fakeTreatments = find_insulin(fakeIOBInputs);
        var fakeDosedOpts = {
            treatments: fakeTreatments
            , profile: opts.profile
            , start: CRDatum.CRInitialIOBTime == null ? CRDatum.CRInitialCarbTime : CRDatum.CRInitialIOBTime
            , end: ( "alternative" in CRDatum ) ? CRDatum.alternative.endTime : CRDatum.CREndTime
        };
        var fakeDosed = dosed(fakeDosedOpts);
        console.error("superBolusSurplus = Math.min( "+Math.abs( fakeDosed.basal )+" , " +( insulinDosed.basal - fakeDosed.basal )+")");
        CRDatum.superBolusSurplus = Math.min(
            insulinDosed.basal - fakeDosed.basal,
            Math.abs( fakeDosed.basal )
        ); // lowest of possible normal basal dose during meal and actual basal dose
        fakeTreatments = null;
        fakeDosedOpts = null;
        fakeDosed = null;
    });
    var fakeStart = new Date ( new Date( minBGDate.getTime() + 12*3600*1000 ).toDateString() );
    //console.error("TDD time start",fakeStart," ",new Date( minBGDate.getTime() + 12*3600*1000));
    console.error("TDD time start",fakeStart);
    var fakeEnd = new Date( new Date( bucketedData[0].date).toDateString() );
    if( fakeEnd.toISOString() == fakeStart.toISOString() ) {
        fakeEnd =  new Date( bucketedData[0].dateString) ;
        //fakeStart =  new Date( new Date( fakeEnd - 24*3600*1000 ).toDateString() );
    }
    console.error("TDD time end",fakeEnd);

    var CSFLength = CSFGlucoseData.length;

    function between(el) { return (el.date <= fakeEnd) && (el.date >= fakeStart);}

    ISFGlucoseData = ISFGlucoseData.filter( between );
    var ISFLength = ISFGlucoseData.length;
    UAMGlucoseData = UAMGlucoseData.filter( between );
    var UAMLength = UAMGlucoseData.length;
    basalGlucoseData = basalGlucoseData.filter( between );
    var basalLength = basalGlucoseData.length;

    if (opts.categorize_uam_as_basal) {
        console.error("--categorize-uam-as-basal=true set: categorizing all UAM data as basal.");
        basalGlucoseData = basalGlucoseData.concat(UAMGlucoseData);
    } else if (CSFLength > 12) {
        console.error("Found at least 1h of carb absorption: assuming all meals were announced, and categorizing UAM data as basal.");
        basalGlucoseData = basalGlucoseData.concat(UAMGlucoseData);
    } else {
        if (2*basalLength < UAMLength) {
            //console.error(basalGlucoseData, UAMGlucoseData);
            console.error("Warning: too many deviations categorized as UnAnnounced Meals");
            console.error("Adding",UAMLength,"UAM deviations to",basalLength,"basal ones");
            basalGlucoseData = basalGlucoseData.concat(UAMGlucoseData);
            //console.error(basalGlucoseData);
            // if too much data is excluded as UAM, add in the UAM deviations to basal, but then discard the highest 50%
            basalGlucoseData.sort(function (a, b) {
                return a.deviation - b.deviation;
            });
            var newBasalGlucose = basalGlucoseData.slice(0,basalGlucoseData.length/2);
            //console.error(newBasalGlucose);
            basalGlucoseData = newBasalGlucose;
            console.error("and selecting the lowest 50%, leaving", basalGlucoseData.length, "basal+UAM ones");
        }

        if (2*ISFLength < UAMLength && ISFLength < 10) {
            console.error("Adding",UAMLength,"UAM deviations to",ISFLength,"ISF ones");
            ISFGlucoseData = ISFGlucoseData.concat(UAMGlucoseData);
            // if too much data is excluded as UAM, add in the UAM deviations to ISF, but then discard the highest 50%
            ISFGlucoseData.sort(function (a, b) {
                return a.deviation - b.deviation;
            });
            var newISFGlucose = ISFGlucoseData.slice(0,ISFGlucoseData.length/2);
            //console.error(newISFGlucose);
            ISFGlucoseData = newISFGlucose;
            console.error("and selecting the lowest 50%, leaving", ISFGlucoseData.length, "ISF+UAM ones");
            //console.error(ISFGlucoseData.length, UAMLength);
        }
    }
    basalLength = basalGlucoseData.length;
    ISFLength = ISFGlucoseData.length;
    if ( 4*basalLength + ISFLength < CSFLength && ISFLength < 10 ) {
        console.error("Warning: too many deviations categorized as meals");
        //console.error("Adding",CSFLength,"CSF deviations to",basalLength,"basal ones");
        //var basalGlucoseData = basalGlucoseData.concat(CSFGlucoseData);
        console.error("Adding",CSFLength,"CSF deviations to",ISFLength,"ISF ones");
        ISFGlucoseData = ISFGlucoseData.concat(CSFGlucoseData);
        CSFGlucoseData = [];
    }

    var savedDia = profileData.dia;
    profileData.dia=24+savedDia;
    IOBInputs = {
        profile: profileData
    ,   history: opts.pumpHistory
    ,   clock: fakeEnd.toISOString()
    };

    treatments = find_insulin(IOBInputs);
    var dosedOpts = {
        treatments: treatments
        , profile: profileData
        , start: fakeStart
        , end: fakeEnd
    };
    var insulinDosed = dosed(dosedOpts);
    dose = 0;
    if(opts.dosed_bolus_only){
        dose = insulinDosed.bolus;
    } else {
        dose = insulinDosed.insulin;
    }
    var fakeIOBInputs = {
        profile: profileData
    ,   history: [ {
                created_at:  fakeStart.toISOString(),
                timestamp:  fakeStart.toISOString(),
                enteredBy: 'openaps://AndroidAPS',
                eventType: 'Temp Basal',
                isValid: true,
                duration:  Math.round(fakeEnd.getTime()-fakeStart.getTime() /60/1000),
                durationInMilliseconds: fakeEnd.getTime()-fakeStart.getTime(),
                type: 'NORMAL',
                rate: 0,
                absolute: 0
            } ]
    ,   clock: fakeEnd.toISOString()
    };
    var fakeTreatments = find_insulin(fakeIOBInputs);
    var fakeDosedOpts = {
            treatments:  fakeTreatments
            , profile: profileData
            , start: fakeStart
            , end: fakeEnd
    };
    var fakeDosed = dosed(fakeDosedOpts);
    var totalBasal =  (insulinDosed.basal-fakeDosed.basal);
    console.error("TDD:"+Math.round(insulinDosed.bolus *1000)/1000+"+"+Math.round(totalBasal *1000)/1000 +"="+Math.round((insulinDosed.bolus+totalBasal)*1000)/1000);
    console.error("TDDAct:"+Math.round(TDDBolusAct * 1000 ) /1000,Math.round(TDDBasalAct * 1000 ) /1000);
    console.error("TDDDownDelta:",TDDDownDelta,"TDDDownAct",Math.round(TDDDownAct * 1000 ) /1000,"TDDIsf", Math.abs(TDDDownDelta)*.0555/TDDDownAct);
    console.error("TDDUpDelta:",TDDUpDelta,"TDDUpAct",Math.round(TDDUpAct * 1000 ) /1000);
    console.error("TDDZeroDelta:",TDDZeroDelta,"TDDZeroAct",Math.round(TDDZeroAct * 1000 ) /1000);
    profileData.dia = savedDia;
    return {
        CRData: CRData,
        CSFGlucoseData: CSFGlucoseData,
        ISFGlucoseData: ISFGlucoseData,
        basalGlucoseData: basalGlucoseData,
        totalBolus: insulinDosed.bolus,
        totalBasal: totalBasal,
        startDate: fakeStart,
        endDate: fakeEnd
    };
}

exports = module.exports = categorizeBGDatums;
// vim:ts=4:sw=4:et
