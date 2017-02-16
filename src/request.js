function request( url, cb ) {
	const xhr  = new XMLHttpRequest();
	xhr.onreadystatechange = function() {
		if ( xhr.readyState >= 4 ) {
			if ( xhr.status == 200 )
				cb( null, xhr.responseText );
			else
				cb( new Error );
		}
	};
	xhr.open( 'GET', url );
	xhr.send();
};
module.exports = request;
