'use strict';
// From https://gist.github.com/IceCreamYou/6ffa1b18c4c8f6aeaad2
// Returns the value at a given percentile in a sorted numeric array.
// "Linear interpolation between closest ranks" method
module.exports = function percentile(arr, p) {
    if (arr.length === 0) return 0;
    if (typeof p !== 'number') throw new TypeError('p must be a number');
    if (p <= 0 || arr.length == 1) return arr[0];
    if (p >= 1) return arr[arr.length - 1];

    //console.error("percentile p",p);
    //console.error("percentile arr.length=",arr.length);
    var index = arr.length * p ,
        lower = Math.floor(index) != index ? Math.floor(index) : index - 1,
        upper = lower + 1,
        weight = (arr.length + 1 ) * .5  % 1; 
    //console.error("percentile index=",index);
    //console.error("percentile weight=",weight);
    //console.error("percentile lower=",lower);
    //console.error("percentile upper=",upper);
    

    if (upper >= arr.length) return arr[lower];
    return arr[lower] * (1 - weight) + arr[upper] * weight;
}
