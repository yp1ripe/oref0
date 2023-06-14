'use strict';

var tz = require('moment-timezone');
var basal = require('../profile/basal');
var getIOB = require('../iob');
var ISF = require('../profile/isf');
var Carbs = require('../profile/carbs');
var find_insulin = require('../iob/history');
var dosed = require('./dosed');

// main function categorizeBGDatums. ;) categorize to ISF, CSF, or basals.

function categorizeBGDatums(opts) {
    var treatments = opts.treatments;
    // this sorts the treatments collection in order.
    treatments.sort(function (a, b) {
        var aDate = new Date(tz(a.timestamp));
        var bDate = new Date(tz(b.timestamp));
        //console.error(aDate);
        return bDate.getTime() - aDate.getTime();
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
            return (obj.date && obj.glucose && obj.glucose >=39);
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
    bucketedData[0] = JSON.parse(JSON.stringify(glucoseData[0]));
    var j=0;
    var k=0; // index of first value used by bucket
    //for loop to validate and bucket the data
    for (var i=1; i < glucoseData.length; ++i) {
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
    var intervalDataISF = null;
    for (i=bucketedData.length-5; i >= 0; --i) {
        glucoseDatum = bucketedData[i];
        //console.error(glucoseDatum);
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
        treatment = treatments[treatments.length-1];
        var myCarbs = 0;
        if (treatment) {
            treatmentDate = new Date(tz(treatment.timestamp));
            treatmentTime = treatmentDate.getTime();
            //console.error(treatment);
            if ( treatmentTime < BGTime ) {
                if (treatment.carbs >= 1 && treatment.hasOwnProperty("duration")==false) {
                    /*if ( calculatingCR ) { 
                        // most likely fast carbs
                        tempImpact = Math.max( profile.min_5m_carbimpact, tempImpact);
                        tempImpact += 5;
                        //console.error("tempImpact+",tempImpact);
                        var cob = mealCOB;
                        impactDecay.push(cob);
                    } */
                    if (  opts.split_large_meals && treatment.carbs > 15 && calculatingCR ) {
                            var CREndIOB = iob;
                            var CREndBG = prevGlucoseDatum.glucose;
                            var CREndTime = new Date(prevGlucoseDatum.date);
                            prevGlucoseDatum.mealAbsorption = "end";
                            //console.error(prevGlucoseDatum.mealAbsorption,"carb absorption");
                            //console.error("CREndIOB:",CREndIOB,"CREndBG:",CREndBG,"CREndTime:",CREndTime);
                            CRCarbs -= mealCOB;
                            prevGlucoseDatum.mealCarbs = mealCOB;
                            mealCarbs = mealCOB;
                            var CRDatum = {
                                CRInitialIOB: CRInitialIOB
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

                            CRData.push(CRDatum);
                            CRCarbs  = mealCOB;
                            CREndTime = null;
                            CRInitialCarbTime = null;

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
                }
                if (treatment.carbs >= 1 && treatment.hasOwnProperty("duration")==true) {
                    extendedCarbsTill = treatmentTime+treatment.duration;
                }
                treatments.pop();
            }
        }

        var BG;
        var delta;
        var avgDelta;
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
            var avgOldDelta = (BG - bucketedData[i+4].glucose)  /4;
            //avgDelta = avgOldDelta;
            //avgOldDelta = avgOldDelta.toFixed(2);
            avgDelta = (BG - bucketedData[i+4].glucose) * 300000 /
                ( new Date( bucketedData[i].date ) - new Date(bucketedData[i+4].date) ) 
            ;
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
        //console.error("Get IOB getIOB(IOBInpus)[0]",IOBInputs.clock);
        // call iob since calculated elsewhere
        if( i == 0 && opts.dbg_output & 1 ) {
            IOBInputs.debug = true;
        }
        var iob = getIOB(IOBInputs,true)[0];
        //console.error(JSON.stringify(iob));

        // activity times ISF times 5 minutes is BGI
        var BGI = Math.round(( -iob.activity * sens * (lag/60000) )*100)/100;
        // datum = one glucose data point (being prepped to store in output)
        glucoseDatum.BGI = BGI;
        // calculating deviation
        var deviation = avgDelta-BGI;
        var dev5m = delta-BGI;
        //console.error(deviation,avgDelta,BG,bucketedData[i].glucose);

        // rounding and storing deviation
        deviation = deviation.toFixed(2);
        dev5m = dev5m.toFixed(2);
        glucoseDatum.deviation = deviation;
        //glucoseDatum.deviation = dev5m;

        if ( !absorbing && mealCOB > 0 ) {
            if ( dev5m > Math.min(2*basalBGI ,profile.min_5m_carbimpact ) ){
                //console.error('Started absorbtion due to deviations ',dev5m,'2*basalBGI',2*basalBGI,'min_5m_carbimpact',profile.min_5m_carbimpact);
                absorbing = 1;
            } else if ( i<=savedI-4 ) {
                //console.error('Started absorbtion due to max delay of 4*5min intervals');
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
            if(CRInitialCarbTime > 0  && BGTime-CRInitialCarbTime >= 4*3600*1000 &&
                BGTime-CRInitialCarbTime <= 4*3600*1000+900*1000 ) {
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
            deviation = (0).toFixed(2);
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
                if( prevGlucoseDatum.mealAbsorption != "end" ) {
                    var CRInitialIOB = prevIob;
                    var CRInitialBG = prevGlucoseDatum.glucose;
                    var CRInitialCarbTime = new Date(prevGlucoseDatum.date);
                } else {
                    var CRInitialIOB = iob;
                    var CRInitialBG = glucoseDatum.glucose;
                    var CRInitialCarbTime = new Date(glucoseDatum.date);
                }
                //console.error("CRInitialIOB:",CRInitialIOB,"CRInitialBG:",CRInitialBG,"CRInitialCarbTime:",CRInitialCarbTime);
            }
            // if meal IOB has decayed, then end absorption after this data point unless COB > 0
            //console.error("currentBasal",currentBasal);
            if ( mealCOB == 0 && absorbing  && impactDecay.length == 0
                 && (end_meal_avgdev >= 0 && iob.iob < currentBasal/2 || BGTime-CRInitialCarbTime>=3600*1000*CRCarbs/10)) {
                absorbing = 0;
                if( end_meal_avgdev <= 0 ) {
                   console.error("deltaT=",(BGTime-CRInitialCarbTime)/1000);
                }
            // otherwise, as long as deviations are positive, keep tracking carb deviations
            //} else if ( mealCOB == 0 && absorbing && deviation <= 3.0 ) {
            } else if ( mealCOB == 0 && absorbing && deviation <= end_meal_avgdev && (end_meal_avgdev >= 0 || BG <= CRInitialBG )) {
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
                if ( CRElapsedMinutes < 60 || ( i===1 && mealCOB > 0 ) || !CRDatum.CRInitialIOB ) {
//                if ( CRElapsedMinutes < 60 || ( i===1 && mealCOB > 0 ) || !CRDatum.CRInitialIOB || CRDatum.CRCarbs <= 15) {
                    console.error("Ignoring",CRElapsedMinutes,"m CR period. (i=",i,",mealCOB=",mealCOB,")");
                } else {
                    CRData.push(CRDatum);
                }

                CRCarbs = 0;
                CREndTime = null;
                CRInitialCarbTime = null;
                calculatingCR = false;
            }
        }


        // If mealCOB is zero but all deviations since hitting COB=0 are positive, assign those data points to CSFGlucoseData
        // Once deviations go negative for at least one data point after COB=0, we can use the rest of the data to tune ISF or basals
        if (mealCOB > 0 || absorbing || mealCarbs > 0) {
            if ( ! absorbing && ! (mealCOB > 0 ) ) {
                mealCarbs = 0;
            }
            // check previous "type" value, and if it wasn't csf, set a mealAbsorption start flag
            //console.error(type);
            if ( absorbing ) {
                if ( type !== "csf" ) {
                    glucoseDatum.mealAbsorption = "start";
                    //console.error(glucoseDatum.mealAbsorption,"carb absorption");
                }
                type="csf";
                // geting rid of up to 6 UAM readings right before the meal ( early bolus, etc ) lest contaminate basal data
                var ual = UAMGlucoseData.length;
                for( var iter = UAMGlucoseData.length-1; iter>0; --iter){
                    if( UAMGlucoseData[iter].date >= glucoseDatum.date - 60*1000*5*(ual - iter) - 60*1000*5  && ual - iter <= 6 ){
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
            //console.error(CSFGlucoseData[CSFGlucoseData.length-1].mealAbsorption,"carb absorption");
          }

          if ((iob.iob > 2 * currentBasal || deviation > 6 || uam) ) {
            if (deviation > 0) {
                uam = 1;
            } else {
                uam = 0;
            }
            if ( type !== "uam" ) {
                glucoseDatum.uamAbsorption = "start";
                console.error(glucoseDatum.uamAbsorption,"uannnounced meal absorption");
            }
            type="uam";
            UAMGlucoseData.push(glucoseDatum);
          } else {
            if ( type === "uam" ) {
                glucoseDatum.uamAbsorption = "end";
                console.error("end unannounced meal absorption");
            }


            // Go through the remaining time periods and divide them into periods where scheduled basal insulin activity dominates. This would be determined by calculating the BG impact of scheduled basal insulin (for example 1U/hr * 48 mg/dL/U ISF = 48 mg/dL/hr = 5 mg/dL/5m), and comparing that to BGI from bolus and net basal insulin activity.
            // When BGI is positive (insulin activity is negative), we want to use that data to tune basals
            // When BGI is smaller than about 1/4 of basalBGI, we want to use that data to tune basals
            // When BGI is negative and more than about 1/4 of basalBGI, we can use that data to tune ISF,
            // unless avgDelta is positive: then that's some sort of unexplained rise we don't want to use for ISF, so that means basals
            if (basalBGI > -4 * BGI) {
                type="basal";
                basalGlucoseData.push(glucoseDatum);
            } else {
                if ( avgDelta > 0 && avgDelta > -2*BGI ) {
                //if ( avgDelta > 0  ) {
                    //type="unknown"
                    type="basal"
                    basalGlucoseData.push(glucoseDatum);
                } else if ( BGTime >= extendedCarbsTill ) {
                //} else  {
                    if( type != "ISF" ) {
                        console.error("start ISF interval");
                        intervalDataISF = {
                            startTime: new Date(prevGlucoseDatum.date),
                            dosed: 0,
                            startBG: prevGlucoseDatum.glucose,
                            startIOB: iob
                        };
                    }
                    type="ISF";
                    ISFGlucoseData.push(glucoseDatum);
                }
            }
          }
        }
        if( intervalDataISF != null && type != "ISF" ) {
            console.error("stop ISF interval");
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
        var BGImmol = (Math.abs(Math.round(BGI/18.018018*100)/100)).toFixed(2).padStart(4,' ');
        var BGmmol = Math.round(BG/18.018018*10)/10;
        var BGstr = (BG.toString() + "|" + BGmmol.toFixed(1).padStart(4,' ')).padStart(8,' ');
        var insulinDosed = 0;
        var CR = 0;
        var TI = 0;
        if( type.substring(0,3) == "csf" && CRInitialCarbTime >0) {
            var tmp_treatments = find_insulin(IOBInputs);
            var dosedOpts = {
                treatments: tmp_treatments
                , profile: opts.profile
                , start: CRInitialCarbTime
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
            if(CRInitialIOB) {
                TI =    CRInitialIOB.iob-iob.iob +dose+(BG-CRInitialBG)/sens ;
            }
            if( TI != 0 ) {
                var carbs = (mealCarbs ? mealCarbs : CRDatum.CRCarbs) - mealCOB;
                CR = ( Math.round( carbs/TI *10 )/10 ).toFixed(1);
            }
        }
        if( type.substring(0,3) == "ISF" && intervalDataISF != null) {
            var tmp_treatments = find_insulin(IOBInputs);
            var dosedOpts = {
                treatments: tmp_treatments
                , profile: opts.profile
                , start: intervalDataISF.startTime
                , end: BGDate
            };
            insulinDosed = dosed(dosedOpts);
            var dose = 0;
            if(opts.dosed_bolus_only){
                dose = insulinDosed.bolus;
            } else {
                dose = insulinDosed.insulin;
            }
            intervalDataISF.dose = dose;
            var doseISF = (intervalDataISF.startIOB.iob - iob.iob + dose );
            TI = Math.round( doseISF*1000)/1000;
            CR = Math.round( (intervalDataISF.startBG - BG ) / doseISF *.0555 * 100 )/100;
        }
 
        console.error( 
            //(bucketedData.length-i) + " " +
            BGTime+' '+
            BGstr+" ∆"+delta.toString().padStart(3,' ')+" av∆"+avgDelta.padStart(6,' ')+
            " BGI"+BGI.toFixed(1).padStart(5,' ')+"|"+BGImmol,
            "σ"+dev5m.padStart(6,' ')+" avσ"+deviation.padStart(6,' ')+( absorbing? ( ci != deviation? '->'+ci : '   ') : '   ')+
            " COB "+absorptionIndicator+(mealCOB.toFixed(1)+"/"+mealCarbs.toFixed(0)).padStart(10,' ')+
            " IOB "+iob.iob.toFixed(3).padStart(6,' ')+" ="+iob.bolusiob.toFixed(3).padStart(6,' ')+( iob.basaliob < 0 ? " -" : " +" ) +Math.abs(iob.basaliob).toFixed(3).padStart(6,' '),
            type.substring(0,3),
myCarbs, TI.toFixed(3),CR
        ); 
        if ( CRCarbs == 0 || CRInitialCarbTime.getTime() == glucoseDatum.date) {
            CRMaxBG = {
                val: 0,
                time: null
            };
            CRMinBG = {
                val: null,
                time: null
            };
        }
    }
      
    IOBInputs = {
        profile: profileData
    ,   history: opts.pumpHistory
    ,   clock: null
    };
    CRData.forEach(function(CRDatum) {
        IOBInputs.clock=CRDatum.CREndTime.toISOString();
        treatments = find_insulin(IOBInputs);

        var dosedOpts = {
            treatments: treatments
            , profile: opts.profile
            , start: CRDatum.CRInitialCarbTime
            , end: CRDatum.CREndTime
        };
        var insulinDosed = dosed(dosedOpts);
        dose = 0;
        if(opts.dosed_bolus_only){
            dose = insulinDosed.bolus;
        } else {
            dose = insulinDosed.insulin;
        }
        CRDatum.CRInsulin = dose;
        CRDatum.dosed  = insulinDosed;
        //console.error("dosed = ",dose, insulinDosed);
        //console.error(CRDatum);
        var fakeIOBInputs = {
            profile: profileData
        ,   history: [ {
                created_at: CRDatum.CRInitialCarbTime.toISOString(),
                timestamp: CRDatum.CRInitialCarbTime.toISOString(),
                enteredBy: 'openaps://AndroidAPS',
                eventType: 'Temp Basal',
                isValid: true,
                duration:  Math.round(CRDatum.CREndTime.getTime()-CRDatum.CRInitialCarbTime.getTime() /60/1000),
                durationInMilliseconds: CRDatum.CREndTime.getTime()-CRDatum.CRInitialCarbTime.getTime(),
                type: 'NORMAL',
                rate: 0,
                absolute: 0
            } ]
        ,   clock: CRDatum.CREndTime.toISOString()
        };
        var fakeTreatments = find_insulin(fakeIOBInputs);
        var fakeDosedOpts = {
            treatments: fakeTreatments
            , profile: opts.profile
            , start: CRDatum.CRInitialCarbTime
            , end: CRDatum.CREndTime
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

    var CSFLength = CSFGlucoseData.length;
    var ISFLength = ISFGlucoseData.length;
    var UAMLength = UAMGlucoseData.length;
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

    var fakeStart = new Date ( new Date( bucketedData[bucketedData.length-5].date).toDateString() );
    var fakeEnd = new Date( new Date( bucketedData[0].date).toDateString() );
    if( fakeEnd.toISOString() == fakeStart.toISOString() ) {
        fakeEnd =  new Date( bucketedData[0].dateString) ;
    }
    var savedDia = profileData.dia;
    profileData.dia=24;
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
    profileData.dia = savedDia;
    return {
        CRData: CRData,
        CSFGlucoseData: CSFGlucoseData,
        ISFGlucoseData: ISFGlucoseData,
        basalGlucoseData: basalGlucoseData,
        totalBolus: insulinDosed.bolus,
        totalBasal: totalBasal
    };
}

exports = module.exports = categorizeBGDatums;
// vim:ts=4:sw=4:et
