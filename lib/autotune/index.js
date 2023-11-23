var percentile = require('../percentile')
var isfProfUtil = require('../profile/isf');

// does three things - tunes basals, ISF, and CSF

function tuneAllTheThings (inputs) {

    var previousAutotune = inputs.previousAutotune;
    //console.error(previousAutotune);
    var pumpProfile = inputs.pumpProfile;
    var pumpBasalProfile = pumpProfile.basalprofile;
    //console.error(pumpBasalProfile);
    var basalProfile = previousAutotune.basalprofile;
    //console.error(basalProfile);
    var isfProfile = previousAutotune.isfProfile;
    //console.error(isfProfile);
    var ISF = isfProfile.sensitivities[0].sensitivity;
    //console.error(ISF);
    var carbRatio = previousAutotune.carb_ratio;
    //console.error(carbRatio);
    var CSF = ISF / carbRatio;
    var DIA = previousAutotune.dia;
    var peak = previousAutotune.insulinPeakTime;
    if (! previousAutotune.useCustomPeakTime === true) {
        if ( previousAutotune.curve === "ultra-rapid" ) {
            peak = 55;
        } else {
            peak = 75;
        }
    }
    //console.error(DIA, peak);

    // conditional on there being a pump profile; if not then skip
    if (pumpProfile) { var pumpISFProfile = pumpProfile.isfProfile; }
    if (pumpISFProfile && pumpISFProfile.sensitivities[0]) {
        var pumpISF = pumpISFProfile.sensitivities[0].sensitivity;
        var pumpCarbRatio = pumpProfile.carb_ratio;
        var pumpCSF = pumpISF / pumpCarbRatio;
    }
    if (! carbRatio) { carbRatio = pumpCarbRatio; }
    if (! CSF) { CSF = pumpCSF; }
    if (! ISF) { ISF = pumpISF; }
    if ( ISF < 36 || pumpISF < 36) {
        CSF = CSF * 18.018018;
        pumpCSF = pumpCSF * 18.018018;
    }
    //console.error(CSF);
    var preppedGlucose = inputs.preppedGlucose;
    var CSFGlucose = preppedGlucose.CSFGlucoseData;
    //console.error(CSFGlucose[0]);
    var ISFGlucose = preppedGlucose.ISFGlucoseData;
    //console.error(ISFGlucose[0]);
    var basalGlucose = preppedGlucose.basalGlucoseData;
    //console.error(basalGlucose[0]);
    var CRData = preppedGlucose.CRData;
    //console.error(CRData);
    var diaDeviations = preppedGlucose.diaDeviations;
    //console.error(diaDeviations);
    var peakDeviations = preppedGlucose.peakDeviations;
    //console.error(peakDeviations);

    // tune DIA
    var newDIA = DIA;
    if (diaDeviations) {
        var currentDIAMeanDev = diaDeviations[2].meanDeviation;
        var currentDIARMSDev = diaDeviations[2].RMSDeviation;
        //console.error(DIA,currentDIAMeanDev,currentDIARMSDev);
        var minMeanDeviations = 1000000;
        var minRMSDeviations = 1000000;
        var meanBest = 2;
        var RMSBest = 2;
        for (var i=0; i < diaDeviations.length; i++) {
            var meanDeviations = diaDeviations[i].meanDeviation;
            var RMSDeviations = diaDeviations[i].RMSDeviation;
            if (meanDeviations < minMeanDeviations) {
                minMeanDeviations = Math.round(meanDeviations*1000)/1000;
                meanBest = i;
            }
            if (RMSDeviations < minRMSDeviations) {
                minRMSDeviations = Math.round(RMSDeviations*1000)/1000;
                RMSBest = i;
            }
        }
        console.error("Best insulinEndTime for meanDeviations:",diaDeviations[meanBest].dia,"hours");
        console.error("Best insulinEndTime for RMSDeviations:",diaDeviations[RMSBest].dia,"hours");
        if ( meanBest < 2 && RMSBest < 2 ) {
            if ( diaDeviations[1].meanDeviation < currentDIAMeanDev * 0.99 && diaDeviations[1].RMSDeviation < currentDIARMSDev * 0.99 ) {
                newDIA = diaDeviations[1].dia;
            }
        } else if ( meanBest > 2 && RMSBest > 2 ) {
            if ( diaDeviations[3].meanDeviation < currentDIAMeanDev * 0.99 && diaDeviations[3].RMSDeviation < currentDIARMSDev * 0.99 ) {
                newDIA = diaDeviations[3].dia;
            }
        }
        if ( newDIA > 12 ) {
            console.error("insulinEndTime maximum is 12h: not raising further");
            newDIA=12;
        }
        if ( newDIA !== DIA ) {
            console.error("Adjusting insulinEndTime from",DIA,"to",newDIA,"hours");
        } else {
            console.error("Leaving insulinEndTime unchanged at",DIA,"hours");
        }
    }

    // tune insulinPeakTime
    var newPeak = peak;
    if (peakDeviations && peakDeviations[2]) {
        var currentPeakMeanDev = peakDeviations[2].meanDeviation;
        var currentPeakRMSDev = peakDeviations[2].RMSDeviation;
        //console.error(currentPeakMeanDev);
        minMeanDeviations = 1000000;
        minRMSDeviations = 1000000;
        meanBest = 2;
        RMSBest = 2;
        for (i=0; i < peakDeviations.length; i++) {
            meanDeviations = peakDeviations[i].meanDeviation;
            RMSDeviations = peakDeviations[i].RMSDeviation;
            if (meanDeviations < minMeanDeviations) {
                minMeanDeviations = Math.round(meanDeviations*1000)/1000;
                meanBest = i;
            }
            if (RMSDeviations < minRMSDeviations) {
                minRMSDeviations = Math.round(RMSDeviations*1000)/1000;
                RMSBest = i;
            }
        }
        console.error("Best insulinPeakTime for meanDeviations:",peakDeviations[meanBest].peak,"minutes");
        console.error("Best insulinPeakTime for RMSDeviations:",peakDeviations[RMSBest].peak,"minutes");
        if ( meanBest < 2 && RMSBest < 2 ) {
            if ( peakDeviations[1].meanDeviation < currentPeakMeanDev * 0.99 && peakDeviations[1].RMSDeviation < currentPeakRMSDev * 0.99 ) {
                newPeak = peakDeviations[1].peak;
            }
        } else if ( meanBest > 2 && RMSBest > 2 ) {
            if ( peakDeviations[3].meanDeviation < currentPeakMeanDev * 0.99 && peakDeviations[3].RMSDeviation < currentPeakRMSDev * 0.99 ) {
                newPeak = peakDeviations[3].peak;
            }
        }
        if ( newPeak !== peak ) {
            console.error("Adjusting insulinPeakTime from",peak,"to",newPeak,"minutes");
        } else {
            console.error("Leaving insulinPeakTime unchanged at",peak);
        }
    }



    // Calculate carb ratio (CR) independently of CSF and ISF
    // Use the time period from meal bolus/carbs until COB is zero and IOB is < currentBasal/2
    // For now, if another meal IOB/COB stacks on top of it, consider them together
    // Compare beginning and ending BGs, and calculate how much more/less insulin is needed to neutralize
    // Use entered carbs vs. starting IOB + delivered insulin + needed-at-end insulin to directly calculate CR.

    var CRTotalCarbs = 0;
    var CRTotalInsulin = 0;
    var totalMealCarbs = 0;
    var totalDeviations = 0;
    var scaledInsulin = 0;
    var dosedBolus = 0;
    // cap adjustments at autosens_max and autosens_min
    if (typeof pumpProfile.autosens_max !== 'undefined') {
        var autotuneMax = pumpProfile.autosens_max;
    } else {
        var autotuneMax = 1.2;
    }
    if (typeof pumpProfile.autosens_min !== 'undefined') {
        var autotuneMin = pumpProfile.autosens_min;
    } else {
        var autotuneMin = 0.7;
    }
    var roundTo = 1000;
    if( inputs.params["round-basals-to"] ) {
        roundTo = inputs.params["round-basals-to"];
    }
    CRData.forEach(function(CRDatum) {
        var CRBGChange = 0;
        var CRIOBChange =  0;
        var CRInsulinReq = 0;
        var currISF = 1;
        var lr = null;
        var CRperc = 100;

        //console.error(CRDatum);
        if( "bolusCalc" in CRDatum && "percentageCorrection" in CRDatum.bolusCalc ) {
            CRperc = CRDatum.bolusCalc.percentageCorrection;
        }

        [ currISF, lr ] = isfProfUtil.isfLookup( isfProfile, new Date( CRDatum.CRInitialCarbTime ), lr );

        CRBGChange = CRDatum.CREndBG - CRDatum.CRInitialBG;
        CRInsulinReq = CRBGChange / currISF;
        CRIOBChange = CRDatum.CRInitialIOB.iob - CRDatum.CREndIOB.iob;
        CRDatum.CRInsulinTotal = CRIOBChange + CRDatum.CRInsulin + CRInsulinReq;

        var CR = Math.round( CRDatum.CRCarbs / CRDatum.CRInsulinTotal * 1000 )/1000;
        var CRInitialCarbTime = new Date( CRDatum.CRInitialCarbTime ).getTime();
        var CREndTime = new Date(  CRDatum.CREndTime ).getTime();
        var startTime = ( "CRInitialIOBTime" in CRDatum && CRDatum.CRInitialIOBTime != null ) ?
                            CRDatum.CRInitialIOBTime : CRDatum.CRInitialCarbTime;
        var bgnArr = new Date( startTime ).toString().split(" ");
        bgnTime = bgnArr[4];
        var endArr = new Date( CREndTime ).toString().split(" ");
        endTime = endArr[4];
        console.error(
            "Meal",bgnTime+"-"+endTime
        );
        console.error(
            "    CR (g/u)          :",CR.toString().padStart(5,' '),"=",
            (Math.round( CRDatum.CRCarbs * 10 )/10)+ " / "+ Math.round( CRDatum.CRInsulinTotal*1000 )/1000,";",
            Math.round( CRDatum.CRInsulinTotal*1000 )/1000,"=",
            Math.round( CRDatum.CRInitialIOB.iob * 1000)/1000, "-", Math.round( CRDatum.CREndIOB.iob * 1000)/1000, "+",
            CRDatum.CRInsulin,"+", Math.round(CRInsulinReq*1000)/1000,";",
            Math.round(CRInsulinReq*1000)/1000,"= (",CRDatum.CREndBG, " - " , CRDatum.CRInitialBG, " ) / " , currISF
        );
        if( "alternative" in CRDatum) {
            //console.error(CRDatum.dosed);
            //console.error(CRDatum.alternative.dosed);
            CRBGChange = CRDatum.alternative.bg - CRDatum.CRInitialBG;
            CRInsulinReq = CRBGChange / currISF;
            CRIOBChange = CRDatum.CRInitialIOB.iob - CRDatum.alternative.iob.iob;
            CRDatum.CRInsulinTotal = CRIOBChange + CRDatum.alternative.dosed.insulin + CRInsulinReq;

            var CR = Math.round( CRDatum.CRCarbs / CRDatum.CRInsulinTotal * 1000 )/1000;
            var CRInitialCarbTime = new Date( CRDatum.CRInitialCarbTime ).getTime();
            var CREndTime = new Date(  CRDatum.alternative.endTime ).getTime();
            var startTime = ( "CRInitialIOBTime" in CRDatum && CRDatum.CRInitialIOBTime != null ) ?
                                CRDatum.CRInitialIOBTime : CRDatum.CRInitialCarbTime;
            var bgnArr = new Date( startTime ).toString().split(" ");
            bgnTime = bgnArr[4];
            var endArr = new Date( CREndTime ).toString().split(" ");
            endTime = endArr[4];
            console.error(
                "alt:",bgnTime+"-"+endTime
            );
            console.error(
                "    CR (g/u)          :",CR.toString().padStart(5,' '),"=",
                (Math.round( CRDatum.CRCarbs * 10 )/10)+ " / "+ Math.round( CRDatum.CRInsulinTotal*1000 )/1000,";",
                Math.round( CRDatum.CRInsulinTotal*1000 )/1000,"=",
                Math.round( CRDatum.CRInitialIOB.iob * 1000)/1000, "-", Math.round( CRDatum.alternative.iob.iob * 1000)/1000, "+",
                CRDatum.alternative.dosed.insulin,"+", Math.round(CRInsulinReq*1000)/1000,";",
                Math.round(CRInsulinReq*1000)/1000,"= (",CRDatum.alternative.bg, " - " , CRDatum.CRInitialBG, " ) / " , currISF
            );
        }
        var scaleFactor = 1;
        var limitedScaleFactor = 1 ;
        var saferScaleFactor = 1;
        var maxDosed = Math.max( CRDatum.dosed.bolus, CRDatum.CRInsulinTotal );
        var superBolusFactor = (maxDosed + CRDatum.superBolusSurplus) / maxDosed;
        var CRMaxIncrease = CRDatum.CRMaxBG.val - CRDatum.CRMinBG.val;
        if ( CRDatum.CRMaxBG.val > 180 ) {
            //scaleFactor = ( CRMaxIncrease > 100 ? (CRMaxIncrease / 100) : ( CRMaxIncrease > 81 ? CRMaxIncrease/ 81 : 1 ) );
            scaleFactor =  CRMaxIncrease > 81 ? CRMaxIncrease/ 81 : 1 ;

            limitedScaleFactor =  Math.min( 1/autotuneMin*.5+ autotuneMax*.5, scaleFactor );
            saferScaleFactor =  Math.min(
                limitedScaleFactor,
                Math.max( superBolusFactor, 1)
            );

        }
        if (CRDatum.CRInsulinTotal > 0) {
            CRTotalCarbs += CRDatum.CRCarbs;
            CRTotalInsulin += CRDatum.CRInsulinTotal;
            dosedBolus +=  maxDosed;
            scaledInsulin += maxDosed*saferScaleFactor;
            //console.error("CRTotalCarbs:",CRTotalCarbs,"CRTotalInsulin:",CRTotalInsulin,"scaledInsulin:",scaledInsulin);
        }
        var numBGsamples=0;
        deviations = 0;
        for (i=0; i < CSFGlucose.length; ++i) {
            var glucoseTime = new Date( CSFGlucose[i].dateString ).getTime();
            if(  glucoseTime  < CRInitialCarbTime || glucoseTime > CREndTime ) {
                continue;
            }
            numBGsamples += 1;
            if ( CSFGlucose[i].mealAbsorption === "start" ) {
                deviations = 0;
                mealCarbs = parseFloat(CSFGlucose[i].mealCarbs);
            } else if (CSFGlucose[i].mealAbsorption === "end") {
                deviations += parseFloat(CSFGlucose[i].deviation);
                // compare the sum of deviations from start to end vs. current CSF * mealCarbs
                mealCarbs -= parseFloat(CSFGlucose[i].mealCarbs);
                totalMealCarbs += mealCarbs;
                totalDeviations += deviations;
                //console.error( new Date( CRDatum.CRInitialCarbTime ).toString().split(" ")[4],"totalDeviations",totalDeviations);
            } else {
                if( 'realDeviation' in CSFGlucose[i] ) {
                    deviations += Math.max(0,parseFloat(CSFGlucose[i].realDeviation));
                } else {
                    deviations += Math.max(0*previousAutotune.min_5m_carbimpact,parseFloat(CSFGlucose[i].deviation));
                }
                mealCarbs = Math.max(mealCarbs, parseFloat(CSFGlucose[i].mealCarbs));
            }
        }
        //console.error("samples",numBGsamples);
        var mealCSF = deviations/mealCarbs;
        var mealISF = mealCSF*CR;
        var mealISFmmol = Math.round( mealISF/18.018018*1000)/1000;
        //console.error(
        //    "  deviations:", Math.round( deviations *100 )/100,"mealCarbs:", Math.round( mealCarbs*100 )/100,
        //    "mealCSF:", Math.round( mealCSF*10000 )/10000,
        //);
        console.error(
            "    mealCSF (mmol/l/g):",Math.round( mealCSF/18.018018*10000 )/10000+" =",
            Math.round( deviations *100 )/100 , "/ 18.018018 /" , Math.round( mealCarbs*100 )/100
        );
        //console.error("naiveISF:",Math.round( mealISF * 10000 ) / 10000,"naiveISF(mmol/l):",mealISFmmol);
        console.error(
            "    naiveISF(mmol/l/u):",mealISFmmol,"=", Math.round( mealCSF/18.018018*10000 )/10000, "*", CR
        );
        console.error(
            "    CRMaxIncrease: ",  CRDatum.CRMaxBG.val, " - ", CRDatum.CRMinBG.val, " = ",CRMaxIncrease
        );
        console.error(
            "    scaleFactor(raw): ", Math.round( scaleFactor *1000)/1000,
            "    (limited): ",Math.round( limitedScaleFactor *1000)/1000,
            "    superBolusFactor: ",Math.round( superBolusFactor *1000)/1000
        );
        console.error(
            "    saferScaleFactor: ", Math.round( saferScaleFactor *1000)/1000,
        );
        console.error(
            "    scaledInsulin: ", Math.round( Math.max( CRDatum.CRInsulinTotal, CRDatum.dosed.bolus)*saferScaleFactor * 1000 ) / 1000
        );
        console.error(
            "    scaledCR (g/u):",Math.round( CRDatum.CRCarbs  / Math.max( CRDatum.CRInsulinTotal, CRDatum.dosed.bolus ) / saferScaleFactor * 1000 )/1000
        );

    });
    CRTotalInsulin = Math.round(CRTotalInsulin*1000)/1000;
    var totalCSF = totalDeviations/totalMealCarbs;
    var totalISF = totalCSF * CRTotalCarbs / CRTotalInsulin
    var totalISFmmol = Math.round( totalISF/18.018018*1000)/1000;
    var totalCR = Math.round( CRTotalCarbs / CRTotalInsulin * 1000 )/1000;
    var scaledCR = Math.round( CRTotalCarbs / scaledInsulin * 1000 )/1000;
    console.error("Total:");
    console.error(
        "    CR (g/u):        ", totalCR, " = ", CRTotalCarbs,"/",CRTotalInsulin
    );
    console.error(
        "    scaledCR (g/u):        ", scaledCR , " = ", CRTotalCarbs,"/", Math.round( scaledInsulin * 1000) /1000
    );
    console.error(
        "    CSF (mmol/l):    ",Math.round( totalCSF/18.018018*10000 )/10000+" =",
        Math.round( totalDeviations *100 )/100 , "/ 18.018018 /" , Math.round( totalMealCarbs*100 )/100
    );
    console.error(
        "    naiveISF(mmol/l):",totalISFmmol," =", Math.round( totalCSF/18.018018*10000 )/10000, "*", totalCR
    );
    //console.error("totalDeviations:", Math.round( totalDeviations*100 )/100,
	//      "totalMealCarbs:", Math.round ( totalMealCarbs*10)/10,
	//      "totalCSF:", Math.round( totalCSF*10000)/10000,
	//      "totalCSF mmol:", Math.round( totalCSF/18.018018*10000)/10000
    //);
    // convert the basal profile to hourly if it isn't already
    var hourlyBasalProfile = [];
    var hourlyPumpProfile = [];
    for (i=0; i < 24; i++) {
        // autotuned basal profile
        for (var j=0; j < basalProfile.length; ++j) {
            if (basalProfile[j].minutes <= i * 60) {
                if (basalProfile[j].rate === 0) {
                    console.error("ERROR: bad basalProfile",basalProfile[j]);
                    return;
                }
                hourlyBasalProfile[i] = JSON.parse(JSON.stringify(basalProfile[j]));
            }
        }
        hourlyBasalProfile[i].i=i;
        hourlyBasalProfile[i].minutes=i*60;
        var zeroPadHour = ("000"+i).slice(-2);
        hourlyBasalProfile[i].start=zeroPadHour + ":00:00";
        hourlyBasalProfile[i].rate=Math.round(hourlyBasalProfile[i].rate*1000)/1000
        // pump basal profile
        if (pumpBasalProfile && pumpBasalProfile[0]) {
            for (j=0; j < pumpBasalProfile.length; ++j) {
                //console.error(pumpBasalProfile[j]);
                if (pumpBasalProfile[j].rate === 0) {
                    console.error("ERROR: bad pumpBasalProfile",pumpBasalProfile[j]);
                    return;
                }
                if (pumpBasalProfile[j].minutes <= i * 60) {
                    hourlyPumpProfile[i] = JSON.parse(JSON.stringify(pumpBasalProfile[j]));
                }
            }
            hourlyPumpProfile[i].i=i;
            hourlyPumpProfile[i].minutes=i*60;
            hourlyPumpProfile[i].rate=Math.round(hourlyPumpProfile[i].rate*1000)/1000
        }
    }
    //console.error(hourlyPumpProfile);
    //console.error(hourlyBasalProfile);
    var newHourlyBasalProfile = JSON.parse(JSON.stringify(hourlyBasalProfile));

    // look at net deviations for each hour
    for (var hour=0; hour < 24; hour++) {
        var deviations = 0;
        for (i=0; i < basalGlucose.length; ++i) {
            var BGTime;

            if (basalGlucose[i].date) {
                BGTime = new Date(basalGlucose[i].date);
            } else if (basalGlucose[i].displayTime) {
                BGTime = new Date(basalGlucose[i].displayTime.replace('T', ' '));
            } else if (basalGlucose[i].dateString) {
                BGTime = new Date(basalGlucose[i].dateString);
            } else {
                console.error("Could not determine last BG time");
            }

            var myHour = BGTime.getHours();
            if (hour === myHour) {
                //console.error(basalGlucose[i].deviation);
                deviations += parseFloat(basalGlucose[i].deviation);
            }
        }
        deviations = Math.round( deviations * 1000 ) / 1000
        console.error("Hour",hour.toString(),"total deviations:",deviations,"mg/dL");
        // calculate how much less or additional basal insulin would have been required to eliminate the deviations
        // only apply 20% of the needed adjustment to keep things relatively stable
        var basalNeeded = 0.2 * deviations / ISF;
        basalNeeded = Math.round( basalNeeded * 100 ) / 100
        // if basalNeeded is positive, adjust each of the 1-3 hour prior basals by 10% of the needed adjustment
        console.error("Hour",hour,"basal adjustment needed:",basalNeeded,"U/hr");
        if (basalNeeded > 0 ) {
            if ( basalNeeded / hourlyPumpProfile[hour].rate  > autotuneMax ) {
                    basalNeeded = Math.round( hourlyPumpProfile[hour].rate * autotuneMax * 100 )/ 100;
                    console.error("Hour",hour,
                    "rate",  hourlyPumpProfile[hour].rate,"basal adjustment is too big, limiting to ",basalNeeded);
            }
            for (var offset=-3; offset < 0; offset++) {
                var offsetHour = hour + offset;
                if (offsetHour < 0) { offsetHour += 24; }
                //console.error(offsetHour);
                newHourlyBasalProfile[offsetHour].rate += basalNeeded / 3;
                newHourlyBasalProfile[offsetHour].rate=Math.round(newHourlyBasalProfile[offsetHour].rate*1000)/1000
            }
        // otherwise, figure out the percentage reduction required to the 1-3 hour prior basals
        // and adjust all of them downward proportionally
        } else if (basalNeeded < 0) {
            var threeHourBasal = 0;
            for (offset=-3; offset < 0; offset++) {
                offsetHour = hour + offset;
                if (offsetHour < 0) { offsetHour += 24; }
                //console.error("Hour", offsetHour," rate",newHourlyBasalProfile[offsetHour].rate);
                threeHourBasal += newHourlyBasalProfile[offsetHour].rate;
            }
            var flattenedRatio = basalNeeded / threeHourBasal;
            var adjustmentRatio = 1.0 ;
            if ( flattenedRatio  > -1 ) {
                adjustmentRatio += flattenedRatio;
            } else {
                console.error("oops, we don't have ",basalNeeded,", so limiting ratio to profile.autosens_min",autotuneMin);
                adjustmentRatio = autotuneMin;
            }
            //console.error("basal needed", basalNeeded,"threeHourBasal",threeHourBasal, "adjustmentRatio",adjustmentRatio);
            for (offset=-3; offset < 0; offset++) {
                offsetHour = hour + offset;
                if (offsetHour < 0) { offsetHour += 24; }
                newHourlyBasalProfile[offsetHour].rate = newHourlyBasalProfile[offsetHour].rate * adjustmentRatio;
                newHourlyBasalProfile[offsetHour].rate=Math.round(newHourlyBasalProfile[offsetHour].rate*1000)/1000
            }
        }
    }
    if (pumpBasalProfile && pumpBasalProfile[0]) {
        for (hour=0; hour < 24; hour++) {
            //console.error(newHourlyBasalProfile[hour],hourlyPumpProfile[hour].rate*1.2);
            var maxRate = Math.max(hourlyPumpProfile[hour].rate * autotuneMax,hourlyPumpProfile[hour].rate+1/roundTo);
            var minRate = Math.min(hourlyPumpProfile[hour].rate * autotuneMin,Math.max(hourlyPumpProfile[hour].rate-1/roundTo,1/roundTo) );
            //console.error("maxRate",maxRate,"minRate",minRate);
            if (newHourlyBasalProfile[hour].rate > maxRate ) {
                console.error("Limiting hour",hour,"basal to",maxRate.toFixed(2),"(which is",autotuneMax,"* pump basal of",hourlyPumpProfile[hour].rate,")");
                //console.error("Limiting hour",hour,"basal to",maxRate.toFixed(2),"(which is 20% above pump basal of",hourlyPumpProfile[hour].rate,")");
                newHourlyBasalProfile[hour].rate = maxRate;
            } else if (newHourlyBasalProfile[hour].rate < minRate ) {
                console.error("Limiting hour",hour,"basal to",minRate.toFixed(2),"(which is",autotuneMin,"* pump basal of",hourlyPumpProfile[hour].rate,")");
                //console.error("Limiting hour",hour,"basal to",minRate.toFixed(2),"(which is 20% below pump basal of",hourlyPumpProfile[hour].rate,")");
                newHourlyBasalProfile[hour].rate = minRate;
            }
            newHourlyBasalProfile[hour].rate = Math.round(newHourlyBasalProfile[hour].rate*1000)/1000;
        }
    }

    // some hours of the day rarely have data to tune basals due to meals.
    // when no adjustments are needed to a particular hour, we should adjust it toward the average of the
    // periods before and after it that do have data to be tuned

    var lastAdjustedHour = 23;
    // scan through newHourlyBasalProfile and find hours where the rate is unchanged
    var totalDailyBasal = 0;
    for (hour=0; hour < 24; hour++) {
        if (Math.round(hourlyBasalProfile[hour].rate*roundTo)/roundTo === Math.round(newHourlyBasalProfile[hour].rate*roundTo)/roundTo) {
            var nextAdjustedHour = 23;
            for (var nextHour = hour; nextHour < 24; nextHour++) {
                if (! (Math.round(hourlyBasalProfile[nextHour].rate*roundTo)/roundTo === Math.round(newHourlyBasalProfile[nextHour].rate*roundTo)/roundTo) ) {
                    nextAdjustedHour = nextHour;
                    break;
                //} else {
                    //console.error(nextHour, hourlyBasalProfile[nextHour].rate, newHourlyBasalProfile[nextHour].rate);
                }
            }
            //console.error(hour, newHourlyBasalProfile);
            var k1 = 1;
            if( roundTo >= 20 ) {
                k1 = .6
            } else {
                k1 = .8
            }

            var k2 = (1-k1)/2;

            newHourlyBasalProfile[hour].rate = Math.round( (k1*hourlyBasalProfile[hour].rate + k2*newHourlyBasalProfile[lastAdjustedHour].rate + k2*newHourlyBasalProfile[nextAdjustedHour].rate)*1000 )/1000;
			if (newHourlyBasalProfile[hour].untuned)
				newHourlyBasalProfile[hour].untuned++;
			else
				newHourlyBasalProfile[hour].untuned = 1;
            console.error("Adjusting hour",hour,"basal from",hourlyBasalProfile[hour].rate,"to",newHourlyBasalProfile[hour].rate,"based on hour",lastAdjustedHour,"=",newHourlyBasalProfile[lastAdjustedHour].rate,"and hour",nextAdjustedHour,"=",newHourlyBasalProfile[nextAdjustedHour].rate);
        } else {
            lastAdjustedHour = hour;
        }
    }
    console.error(newHourlyBasalProfile);
    for (hour=0; hour < 24; hour++) {
        newHourlyBasalProfile[hour].rate = Math.round( newHourlyBasalProfile[hour].rate*roundTo )/roundTo;
        totalDailyBasal += newHourlyBasalProfile[hour].rate;
    }

    totalDailyBasal = Math.round(totalDailyBasal*roundTo)/roundTo;

    if( inputs.params["compress-basal-profile"] ) {
        for (hour=1; hour < newHourlyBasalProfile.length; hour++) {
            //console.error("hour=",hour,newHourlyBasalProfile[hour]);
            if( newHourlyBasalProfile[hour].rate == newHourlyBasalProfile[hour-1].rate ) {
                newHourlyBasalProfile.splice(hour,1);
                //console.error("after splice",newHourlyBasalProfile);
                hour--;
                //console.error("after splice",hour,newHourlyBasalProfile.length);
            }
        }
    }

    console.error(newHourlyBasalProfile);
    basalProfile = newHourlyBasalProfile;

    // Calculate carb ratio (CR) independently of CSF and ISF
    // Use the time period from meal bolus/carbs until COB is zero and IOB is < currentBasal/2
    // For now, if another meal IOB/COB stacks on top of it, consider them together
    // Compare beginning and ending BGs, and calculate how much more/less insulin is needed to neutralize
    // Use entered carbs vs. starting IOB + delivered insulin + needed-at-end insulin to directly calculate CR.



    // calculate net deviations while carbs are absorbing
    // measured from carb entry until COB and deviations both drop to zero

    var deviations = 0;
    var mealCarbs = 0;
    var totalMealCarbs = 0;
    var totalDeviations = 0;
    var fullNewCSF;
    //console.error(CSFGlucose[0].mealAbsorption);
    //console.error(CSFGlucose[0]);
    for (i=0; i < CSFGlucose.length; ++i) {
        //console.error(CSFGlucose[i].mealAbsorption, i);
        //if ( typeof(CSFGlucose[i].mealAbsorption) !== 'undefined' ) {
        //    console.error(CSFGlucose[i].mealAbsorption,i);
        //}
        if ( CSFGlucose[i].mealAbsorption === "start" ) {
            deviations = 0;
            mealCarbs = parseFloat(CSFGlucose[i].mealCarbs);
        } else if (CSFGlucose[i].mealAbsorption === "end") {
            deviations += parseFloat(CSFGlucose[i].deviation);
            // compare the sum of deviations from start to end vs. current CSF * mealCarbs
            mealCarbs -= parseFloat(CSFGlucose[i].mealCarbs);
            //console.error(CSF,mealCarbs);
            var csfRise = CSF * mealCarbs;
            //console.error(deviations,ISF);
            //console.error("csfRise:",csfRise,"deviations:",deviations);
            totalMealCarbs += mealCarbs;
            totalDeviations += deviations;

        } else {
            deviations += Math.max(0*previousAutotune.min_5m_carbimpact,parseFloat(CSFGlucose[i].deviation));
            mealCarbs = Math.max(mealCarbs, parseInt(CSFGlucose[i].mealCarbs));
        }
    }
    // at midnight, write down the mealcarbs as total meal carbs (to prevent special case of when only one meal and it not finishing absorbing by midnight)
    // TODO: figure out what to do with dinner carbs that don't finish absorbing by midnight
    if (totalMealCarbs === 0) { totalMealCarbs += mealCarbs; }
    if (totalDeviations === 0) { totalDeviations += deviations; }
    //console.error(totalDeviations, totalMealCarbs);
    if (totalMealCarbs === 0) {
        // if no meals today, CSF is unchanged
        fullNewCSF = CSF;
    } else {
        // how much change would be required to account for all of the deviations
        fullNewCSF = Math.round( (totalDeviations / totalMealCarbs)*100 )/100;
    }
    // only adjust by 20%
    var newCSF = ( 0.8 * CSF ) + ( 0.2 * fullNewCSF );
    // safety cap CSF
    if (typeof(pumpCSF) !== 'undefined') {
        var maxCSF = pumpCSF * autotuneMax;
        var minCSF = pumpCSF * autotuneMin;
        if (newCSF > maxCSF) {
            console.error("Limiting CSF to",maxCSF.toFixed(2),"(which is",autotuneMax,"* pump CSF of",pumpCSF,")");
            newCSF = maxCSF;
        } else if (newCSF < minCSF) {
            console.error("Limiting CSF to",minCSF.toFixed(2),"(which is",autotuneMin,"* pump CSF of",pumpCSF,")");
            newCSF = minCSF;
        } //else { console.error("newCSF",newCSF,"is close enough to",pumpCSF); }
    }
    var oldCSF = Math.round( CSF * 1000 ) / 1000;
    newCSF = Math.round( newCSF * 1000 ) / 1000;
    totalDeviations = Math.round ( totalDeviations * 1000 )/1000;
    console.error("totalMealCarbs:",totalMealCarbs,"totalDeviations:",totalDeviations,"oldCSF",oldCSF,"fullNewCSF:",fullNewCSF,"newCSF:",newCSF);
    // this is where CSF is set based on the outputs
    if (newCSF) {
        CSF = newCSF;
    }

    if (totalCR === 0) {
        // if no meals today, CR is unchanged
        var fullNewCR = carbRatio;
    } else {
        // how much change would be required to account for all of the deviations
        fullNewCR = totalCR;
    }
    scaledCR = Math.max( totalMealCarbs/dosedBolus*.75,scaledCR ) ;
    if( inputs.params["wizard-percent"] ) {
        fullNewCR = inputs.params["wizard-percent"]/100*fullNewCR;
    }
    fullNewCR = Math.min( fullNewCR, scaledCR );
    var weightFactor = .20;
    if( inputs.params["new-vals-weight"] ) {
        weightFactor = inputs.params["new-vals-weight"]/100;
    }
    // don't tune CR out of bounds
    var maxCR = pumpCarbRatio * autotuneMax;
    if (maxCR > 150) { maxCR = 150 }
    var minCR = pumpCarbRatio * autotuneMin;
    if (minCR < 3) { minCR = 3 }
    // safety cap fullNewCR
    if (typeof(pumpCarbRatio) !== 'undefined') {
        if (fullNewCR > maxCR) {
            console.error("Limiting fullNewCR from",fullNewCR,"to",maxCR.toFixed(2),"(which is",autotuneMax,"* pump CR of",pumpCarbRatio,")");
            fullNewCR = maxCR;
        } else if (fullNewCR < minCR) {
            console.error("Limiting fullNewCR from",fullNewCR,"to",minCR.toFixed(2),"(which is",autotuneMin,"* pump CR of",pumpCarbRatio,")");
            fullNewCR = minCR;
        } //else { console.error("newCR",newCR,"is close enough to",pumpCarbRatio); }
    }
    // only adjust by weightFactor%
    var newCR = ( (1-weightFactor) * carbRatio ) + ( weightFactor * fullNewCR );
    // safety cap newCR
    if (typeof(pumpCarbRatio) !== 'undefined') {
        if (newCR > maxCR) {
            console.error("Limiting CR to",maxCR.toFixed(2),"(which is",autotuneMax,"* pump CR of",pumpCarbRatio,")");
            newCR = maxCR;
        } else if (newCR < minCR) {
            console.error("Limiting CR to",minCR.toFixed(2),"(which is",autotuneMin,"* pump CR of",pumpCarbRatio,")");
            newCR = minCR;
        } //else { console.error("newCR",newCR,"is close enough to",pumpCarbRatio); }
    }
    newCR = Math.round( newCR * 1000 ) / 1000;
    console.error("oldCR:",carbRatio,"fullNewCR:",fullNewCR,"newCR:",newCR);
    // this is where CR is set based on the outputs
    //var ISFFromCRAndCSF = ISF;
    if (newCR) {
        carbRatio = newCR;
        //ISFFromCRAndCSF = Math.round( carbRatio * CSF * 1000)/1000;
    }



    // calculate median deviation and bgi in data attributable to ISF
    var deviations = [];
    var BGIs = [];
    var avgDeltas = [];
    var ratios = [];
    for (i=0; i < ISFGlucose.length; ++i) {
        deviation = parseFloat(ISFGlucose[i].deviation);
        deviations.push(deviation);
        var BGI = parseFloat(ISFGlucose[i].BGI);
        BGIs.push(BGI);
        var avgDelta = parseFloat(ISFGlucose[i].avgDelta);
        avgDeltas.push(avgDelta);
        var ratio = 1 + deviation / BGI;
        //console.error("Deviation:",deviation,"BGI:",BGI,"avgDelta:",avgDelta,"ratio:",ratio);
        ratios.push(ratio);
    }
    avgDeltas.sort(function(a, b){return a-b});
    BGIs.sort(function(a, b){return a-b});
    deviations.sort(function(a, b){return a-b});
    ratios.sort(function(a, b){return a-b});
    var p50deviation = percentile(deviations, 0.50);
    var p50BGI = percentile(BGIs, 0.50);
    var p50ratios = Math.round( percentile(ratios, 0.50) * 1000)/1000;
    var fullNewISF = ISF;
    //console.error( ISFGlucose );
    if (ISFGlucose.length < 10) {
        // leave ISF unchanged if fewer than 10 ISF data points
        console.error ("Only found",ISFGlucose.length,"ISF data points, leaving ISF unchanged at",ISF);
        console.error ("otherwise fullNewISF would be ",Math.round(  ISF * p50ratios * 1000 ) / 1000);
    } else {
        // calculate what adjustments to ISF would have been necessary to bring median deviation to zero
        fullNewISF = ISF * p50ratios;
    }
    fullNewISF = Math.round( fullNewISF * 1000 ) / 1000;
    //console.error("p50ratios:",p50ratios,"fullNewISF:",fullNewISF,ratios[Math.floor(ratios.length/2)]);
    // adjust the target ISF to be a weighted average of fullNewISF and pumpISF
    var adjustmentFraction;

    if (typeof(pumpProfile.autotune_isf_adjustmentFraction) !== 'undefined') {
        adjustmentFraction = pumpProfile.autotune_isf_adjustmentFraction;
    } else {
        adjustmentFraction = 1.0;
    }

    // low autosens ratio = high ISF
    var maxISF = pumpISF / autotuneMin;
    // high autosens ratio = low ISF
    var minISF = pumpISF / autotuneMax;
    if (typeof(pumpISF) !== 'undefined') {
        if ( fullNewISF < 0 ) {
            var adjustedISF = 0;
        } else {
            adjustedISF = adjustmentFraction*fullNewISF + (1-adjustmentFraction)*pumpISF;
        }
        // cap adjustedISF before applying 10%
        //console.error(adjustedISF, maxISF, minISF);
        if (adjustedISF > maxISF) {
            console.error("Limiting adjusted ISF of",adjustedISF.toFixed(2),"to",maxISF.toFixed(2),"(which is pump ISF of",pumpISF,"/",autotuneMin,")");
            adjustedISF = maxISF;
        } else if (adjustedISF < minISF) {
            console.error("Limiting adjusted ISF of",adjustedISF.toFixed(2),"to",minISF.toFixed(2),"(which is pump ISF of",pumpISF,"/",autotuneMax,")");
            adjustedISF = minISF;
        }

        // and apply wightFactor% of that adjustment
        var newISF = (  (1 - weightFactor) * ISF ) + ( weightFactor * adjustedISF );

        if (newISF > maxISF) {
            console.error("Limiting ISF of",newISF.toFixed(2),"to",maxISF.toFixed(2),"(which is pump ISF of",pumpISF,"/",autotuneMin,")");
            newISF = maxISF;
        } else if (newISF < minISF) {
            console.error("Limiting ISF of",newISF.toFixed(2),"to",minISF.toFixed(2),"(which is pump ISF of",pumpISF,"/",autotuneMax,")");
            newISF = minISF;
        }
    }
    newISF = Math.round( newISF * 1000 ) / 1000;
    //console.error(avgRatio);
    //console.error(newISF);
    p50deviation = Math.round( p50deviation * 1000 ) / 1000;
    p50BGI = Math.round( p50BGI * 1000 ) / 1000;
    adjustedISF = Math.round( adjustedISF * 1000 ) / 1000;
    console.error("p50deviation:",p50deviation,"p50BGI",p50BGI,"p50ratios:",p50ratios,"Old ISF:",ISF,"fullNewISF:",fullNewISF,"adjustedISF:",adjustedISF,"newISF:",newISF,"newDIA:",newDIA,"newPeak:",newPeak);

    if (newISF) {
        ISF = newISF;
    }

    // reconstruct updated version of previousAutotune as autotuneOutput
    var autotuneOutput = previousAutotune;
    var outMmols = false;
    if( "bg_targets" in autotuneOutput ) {
        if( "user_preferred_units" in autotuneOutput.bg_targets ) {
            if( autotuneOutput.bg_targets.user_preferred_units == "mmol" ) {
                outMmols = true;
            }
        }
    }
    autotuneOutput.basalprofile = basalProfile;
    isfProfile.sensitivities[0].sensitivity = ISF;
    autotuneOutput.isfProfile = isfProfile;
    for(i=0; i < isfProfile.sensitivities.length; i++) {
        if( isfProfile.sensitivities[i].sensitivity > 20 && outMmols ) {
            isfProfile.sensitivities[i].sensitivity = Math.round( isfProfile.sensitivities[i].sensitivity / 18.018108 *1000)/1000;
        }
    }
    autotuneOutput.sens = ISF;
    if( !outMmols ) {
        autotuneOutput.csf = CSF;
    } else {
        autotuneOutput.csf = Math.round( CSF / 18.018018 * 100000) / 100000;
    }
    //carbRatio = ISF / CSF;
    carbRatio = Math.round( carbRatio * 1000 ) / 1000;
    autotuneOutput.carb_ratio = carbRatio;
    autotuneOutput.dia = newDIA;
    autotuneOutput.insulinPeakTime = newPeak;
    if (diaDeviations || peakDeviations) {
        autotuneOutput.useCustomPeakTime = true;
    }
    console.error("totalDailyBasal=",totalDailyBasal);

    return autotuneOutput;
}

exports = module.exports = tuneAllTheThings;
//  vim:ts=4:sw=4:et
