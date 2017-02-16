require( 'promise/polyfill' );
function request( url ) {
	return new Promise(function( resolve, reject ) {
		const xhr  = new XMLHttpRequest();
		xhr.onreadystatechange = function() {
			if ( xhr.readyState >= 4 ) {
				if ( xhr.status == 200 )
					resolve( xhr.responseText );
				else
					reject( new Error );
			}
		};
		xhr.open( 'GET', url );
		xhr.send()
	});;
};
module.exports = request;
