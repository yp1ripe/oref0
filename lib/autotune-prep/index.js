
// Prep step before autotune.js can run; pulls in meal (carb) data and calls categorize.js 

var find_meals = require('../meal/history');
var categorize = require('./categorize');

function generate (inputs) {

  //console.error(inputs);
  var treatments = find_meals(inputs);

  var opts = {
    treatments: treatments
  , profile: inputs.profile
  , pumpHistory: inputs.history
  , glucose: inputs.glucose
  //, prepped_glucose: inputs.prepped_glucose
  , basalprofile: inputs.profile.basalprofile
  , pumpbasalprofile: inputs.pumpprofile.basalprofile
  , categorize_uam_as_basal: inputs.categorize_uam_as_basal
  , split_large_meals: inputs.split_large_meals
  , end_meal_if_avgdev_le: inputs.end_meal_if_avgdev_le
  , limit_carbs_decay_time: inputs.limit_carbs_decay_time
  , fast_decay_le15g_carbs: inputs.fast_decay_le15g_carbs
  , dosed_bolus_only: inputs.dosed_bolus_only
  , delay_meal_absorption: inputs.delay_meal_absorption
  , combined_isf_basal: inputs.combined_isf_basal
  , detect_PISA: inputs.detect_PISA
  , dbg_output: inputs.dbg_output
  , split30: inputs.split30
  };

  var autotune_prep_output = categorize(opts);

  if (inputs.tune_insulin_curve) {
    if (opts.profile.curve === 'bilinear') {
      console.error('--tune-insulin-curve is set but only valid for exponential curves');
    } else {
      var minDeviations = 1000000;
      var newDIA = 0;
      var diaDeviations = [];
      var peakDeviations = [];
      var currentDIA = opts.profile.dia;
      var currentPeak = opts.profile.insulinPeakTime;

      var consoleError = console.error;
      console.error = function() {};

      var startDIA=currentDIA - 2;
      var endDIA=currentDIA + 2;
      for (var dia=startDIA; dia <= endDIA; ++dia) {
        var sqrtDeviations = 0;
        var deviations = 0;
        var deviationsSq = 0;

        opts.profile.dia = dia;

        var curve_output = categorize(opts);
        var basalGlucose = curve_output.basalGlucoseData;

        for (var hour=0; hour < 24; ++hour) {
          for (var i=0; i < basalGlucose.length; ++i) {
            var BGTime;

            if (basalGlucose[i].date) {
              BGTime = new Date(basalGlucose[i].date);
            } else if (basalGlucose[i].displayTime) {
              BGTime = new Date(basalGlucose[i].displayTime.replace('T', ' '));
            } else if (basalGlucose[i].dateString) {
              BGTime = new Date(basalGlucose[i].dateString);
            } else {
              consoleError("Could not determine last BG time");
            }

            var myHour = BGTime.getHours();
            if (hour === myHour) {
              //console.error(basalGlucose[i].deviation);
              sqrtDeviations += Math.pow(parseFloat(Math.abs(basalGlucose[i].deviation)), 0.5);
              deviations += Math.abs(parseFloat(basalGlucose[i].deviation));
              deviationsSq += Math.pow(parseFloat(basalGlucose[i].deviation), 2);
            }
          }
        }

        var meanDeviation = Math.round(Math.abs(deviations/basalGlucose.length)*1000)/1000;
        var SMRDeviation = Math.round(Math.pow(sqrtDeviations/basalGlucose.length,2)*1000)/1000;
        var RMSDeviation = Math.round(Math.pow(deviationsSq/basalGlucose.length,0.5)*1000)/1000;
        diaDeviations.push({
            dia: dia,
            meanDeviation: meanDeviation,
            SMRDeviation: SMRDeviation,
            RMSDeviation: RMSDeviation,
        });
        autotune_prep_output.diaDeviations = diaDeviations;

        deviations = Math.round(deviations*1000)/1000;
        if (deviations < minDeviations) {
          minDeviations = deviations;
          newDIA = dia;
        }
        consoleError('insulinEndTime', dia, 'deviations',deviations,'meanDeviation:', meanDeviation, 'SMRDeviation:', SMRDeviation, 'RMSDeviation:',RMSDeviation, '(mg/dL)');
      }

      // consoleError('Optimum insulinEndTime', newDIA, 'mean deviation:', Math.round(minDeviations/basalGlucose.length*1000)/1000, '(mg/dL)');
      //consoleError(diaDeviations);

      minDeviations = 1000000;

      var newPeak = 0;
      opts.profile.dia = currentDIA;
      consoleError(opts.profile.useCustomPeakTime, opts.profile.insulinPeakTime);
      if ( ! opts.profile.useCustomPeakTime === true && opts.profile.curve === "ultra-rapid" ) {
        opts.profile.insulinPeakTime = 55;
      } else if ( opts.profile.useCustomPeakTime !== true ) {
        opts.profile.insulinPeakTime = 75;
      }
      consoleError(opts.profile.useCustomPeakTime, opts.profile.insulinPeakTime);
      opts.profile.useCustomPeakTime = true;
      consoleError(opts.profile.useCustomPeakTime, opts.profile.insulinPeakTime);

      var startPeak=opts.profile.insulinPeakTime - 10;
      var endPeak=opts.profile.insulinPeakTime + 10;
      for (var peak=startPeak; peak <= endPeak; peak=(peak+5)) {
        sqrtDeviations = 0;
        deviations = 0;
        deviationsSq = 0;

        opts.profile.insulinPeakTime = peak;


        curve_output = categorize(opts);
        basalGlucose = curve_output.basalGlucoseData;

        for (hour=0; hour < 24; ++hour) {
          for (i=0; i < basalGlucose.length; ++i) {
            if (basalGlucose[i].date) {
              BGTime = new Date(basalGlucose[i].date);
            } else if (basalGlucose[i].displayTime) {
              BGTime = new Date(basalGlucose[i].displayTime.replace('T', ' '));
            } else if (basalGlucose[i].dateString) {
              BGTime = new Date(basalGlucose[i].dateString);
            } else {
              consoleError("Could not determine last BG time");
            }

            myHour = BGTime.getHours();
            if (hour === myHour) {
              //console.error(basalGlucose[i].deviation);
              sqrtDeviations += Math.pow(parseFloat(Math.abs(basalGlucose[i].deviation)), 0.5);
              deviations += Math.abs(parseFloat(basalGlucose[i].deviation));
              deviationsSq += Math.pow(parseFloat(basalGlucose[i].deviation), 2);
            }
          }
        }
//        console.error(deviationsSq);

        meanDeviation = Math.round(deviations/basalGlucose.length*1000)/1000;
        SMRDeviation = Math.round(Math.pow(sqrtDeviations/basalGlucose.length,2)*1000)/1000;
        RMSDeviation = Math.round(Math.pow(deviationsSq/basalGlucose.length,0.5)*1000)/1000;
        peakDeviations.push({
            peak: peak,
            meanDeviation: meanDeviation,
            SMRDeviation: SMRDeviation,
            RMSDeviation: RMSDeviation,
        });
        autotune_prep_output.diaDeviations = diaDeviations;

        deviations = Math.round(deviations*1000)/1000;
        if (deviations < minDeviations) {
          minDeviations = deviations;
          newPeak = peak;
        }
        consoleError('insulinPeakTime', peak, 'deviations',deviations,'meanDeviation:', meanDeviation, 'SMRDeviation:', SMRDeviation, 'RMSDeviation:',RMSDeviation, '(mg/dL)');
      }

      consoleError('Optimum insulinPeakTime', newPeak, 'mean deviation:', Math.round(minDeviations/basalGlucose.length*1000)/1000, '(mg/dL)');
      //consoleError(peakDeviations);
      autotune_prep_output.peakDeviations = peakDeviations;

      console.error = consoleError;
    }
  }

  return autotune_prep_output;
}

exports = module.exports = generate;
